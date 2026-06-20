/**
 * PTY server for CLI mode.
 *
 * Creates a pseudo-terminal, spawns Claude Code inside it,
 * and multiplexes user input + WeChat messages into Claude's stdin.
 *
 * When running as a detached process (bridge), stdout/stdin are piped.
 * We detect this and open the terminal device directly (/dev/tty or CONOUT$).
 */

import * as pty from 'node-pty';
import { writeFileSync, existsSync, mkdirSync, appendFileSync, createWriteStream, createReadStream, unlinkSync } from 'node:fs';
import type { WriteStream, ReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BridgeConfig } from './config.js';
import type { MessageQueue, QueueItem } from './queue.js';

const BRIDGE_DIR = join(homedir(), '.wechat-claude-skill');
const PTY_PID_FILE = join(BRIDGE_DIR, 'pty.pid');
const LOG_FILE = join(BRIDGE_DIR, 'bridge.log');

export interface PTYServerOptions {
  sessionId: string;
  cwd: string;
  config: BridgeConfig;
  queue: MessageQueue;
  onResponse: (output: string) => void;
  onError?: (error: Error) => void;
}

interface TerminalStreams {
  input: ReadStream | NodeJS.ReadStream;
  output: WriteStream | NodeJS.WriteStream;
}

/**
 * Open the terminal device directly.
 * Returns {input, output} streams connected to the terminal.
 * Falls back to process.stdin/stdout if already a TTY.
 *
 * Windows Note: Use \\.\CONIN$ and \\.\CONOUT$ full device paths because
 * Node.js createReadStream/createWriteStream don't recognize CONIN$/CONOUT$
 * as device names (they treat them as relative file paths).
 */
function openTerminal(): TerminalStreams {
  if (process.stdout.isTTY && process.stdin.isTTY) {
    return { input: process.stdin, output: process.stdout };
  }

  // Windows: use full device path with \\.\ prefix
  const ttyPath = process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty';
  const ttyInPath = process.platform === 'win32' ? '\\\\.\\CONIN$' : '/dev/tty';

  try {
    const output = createWriteStream(ttyPath);
    const input = createReadStream(ttyInPath);
    return { input, output };
  } catch (e: any) {
    console.error(`[PTY] Failed to open terminal device: ${e.message}`);
    console.error('[PTY] Falling back to process.stdout/stdin');
    return { input: process.stdin, output: process.stdout };
  }
}

export class PTYServer {
  private ptyProcess: pty.IPty | null = null;
  private outputBuffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private terminal: TerminalStreams;

  /**
   * Timestamp of the last PTY output from Claude.
   * Used to detect whether Claude is currently generating a response.
   * If output was received within the last 2 seconds, Claude is considered "busy".
   */
  private lastOutputTime = 0;

  /** Interval (ms) during which Claude is considered busy after last output. */
  private static readonly BUSY_THRESHOLD_MS = 2000;

  constructor(private options: PTYServerOptions) {
    this.terminal = openTerminal();
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const args = ['--resume', this.options.sessionId];
    this.log(`Starting: claude ${args.join(' ')}`);
    this.log(`Working directory: ${this.options.cwd}`);

    // Get terminal dimensions
    const cols = (this.terminal.output as NodeJS.WriteStream).columns || 120;
    const rows = (this.terminal.output as NodeJS.WriteStream).rows || 30;

    // On Windows, use claude.cmd (node-pty can't run POSIX shell scripts directly)
    const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    this.ptyProcess = pty.spawn(claudeCmd, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.options.cwd,
      env: process.env as Record<string, string>,
    });

    // Save PTY PID
    mkdirSync(BRIDGE_DIR, { recursive: true });
    writeFileSync(PTY_PID_FILE, String(this.ptyProcess.pid), 'utf-8');

    // Forward PTY output to user terminal + buffer for WeChat
    this.ptyProcess.onData((data) => {
      this.lastOutputTime = Date.now();  // Track Claude activity for input lock
      // Write directly to terminal device
      this.terminal.output.write(data);
      // Buffer for WeChat forwarding
      this.bufferOutput(data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this.log(`Claude Code exited with code ${exitCode}`);
      this.terminal.output.write('\n\n========================================\n');
      this.terminal.output.write('🔴 Claude Code 会话已结束\n');
      this.terminal.output.write('========================================\n');
      this.terminal.output.write('你可以：\n');
      this.terminal.output.write('  1. 在当前终端直接输入 ./node 来启动新的 Claude Code\n');
      this.terminal.output.write('  2. 或者在 Claude Code 中执行 /wechat 重新启动\n');
      this.terminal.output.write('  3. 微信消息仍会显示在此终端\n');
      this.terminal.output.write('\n按 Ctrl+C 退出桥梁程序\n');
      // Don't exit - let user see the message and decide
      // Keep polling so WeChat messages still get displayed
      this.running = false;
      this.ptyProcess = null;
    });

    // Forward user terminal input to PTY
    this.terminal.input.resume();
    if ('setRawMode' in this.terminal.input && typeof this.terminal.input.setRawMode === 'function') {
      this.terminal.input.setRawMode(true);
    }
    this.terminal.input.on('data', (data: Buffer | string) => {
      if (this.ptyProcess) {
        this.ptyProcess.write(data.toString());
      }
    });

    // Handle terminal resize (only works with real TTY)
    const stdout = this.terminal.output as NodeJS.WriteStream;
    if (typeof stdout.on === 'function' && stdout.isTTY) {
      stdout.on('resize', () => {
        if (this.ptyProcess) {
          this.ptyProcess.resize(
            stdout.columns || 120,
            stdout.rows || 30,
          );
        }
      });
    }

    // Start queue processor (inject WeChat messages into PTY)
    this.queueTimer = setInterval(() => this.processQueue(), 1000);

    this.log('Ready. User input and WeChat messages are multiplexed.');
  }

  stop(): void {
    this.running = false;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch {}
      this.ptyProcess = null;
    }
    // Clean up PID file
    try { unlinkSync(PTY_PID_FILE); } catch {}
  }

  private bufferOutput(data: string): void {
    this.outputBuffer += data;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushOutput(), 500);
  }

  private flushOutput(): void {
    if (!this.outputBuffer) return;
    this.options.onResponse(this.outputBuffer);
    this.outputBuffer = '';
  }

  private processQueue(): void {
    if (!this.running || !this.ptyProcess || this.options.queue.isEmpty) return;

    if (this.isClaudeBusy()) {
      // Claude is busy (generating response): show notification but don't inject yet
      const item = this.options.queue.peek();
      if (item && !item.notified) {
        this.showWeChatNotification(item);
        item.notified = true;
      }
      return;
    }

    // Claude is idle: inject all pending messages (sorted by timestamp)
    const pending = this.options.queue.dequeueAll();
    pending.sort((a, b) => a.timestamp - b.timestamp);
    for (const item of pending) {
      this.log(`Injecting WeChat message from ${item.from}: ${item.text}`);
      this.ptyProcess.write(item.text + '\n');
    }
  }

  /**
   * Check if Claude is currently busy generating a response.
   * Returns true if output was received within the last BUSY_THRESHOLD_MS (2 seconds).
   */
  private isClaudeBusy(): boolean {
    return Date.now() - this.lastOutputTime < PTYServer.BUSY_THRESHOLD_MS;
  }

  /**
   * Display a WeChat message notification in the terminal with color-coded format.
   * This is shown while waiting for Claude to become idle.
   * Format: [微信 HH:MM:SS] sender: message
   * Colors: cyan for timestamp prefix, yellow for sender name.
   */
  private showWeChatNotification(item: QueueItem): void {
    const time = new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    // ANSI escape codes: \x1b[36m = cyan, \x1b[33m = yellow, \x1b[0m = reset
    const prefix = `\x1b[36m[微信 ${time}]\x1b[0m \x1b[33m${item.from}\x1b[0m: `;
    this.terminal.output.write(prefix + item.text + '\n');
  }

  private log(msg: string): void {
    const now = new Date();
    const ts = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const line = `[${ts}] [PTY] ${msg}\n`;
    try {
      appendFileSync(LOG_FILE, line, 'utf-8');
    } catch {}
    // Also write to terminal if available
    if (this.terminal) {
      this.terminal.output.write(`[PTY] ${msg}\n`);
    }
  }
}
