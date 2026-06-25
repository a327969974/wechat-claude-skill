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
import type { MessageQueue } from './queue.js';

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

  constructor(private options: PTYServerOptions) {
    this.terminal = openTerminal();
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Use --continue (most recent conversation) if no sessionId,
    // or --resume <sessionId> if sessionId is provided
    const args = this.options.sessionId
      ? ['--resume', this.options.sessionId]
      : ['--continue'];
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
    let bannerShown = false;
    this.ptyProcess.onData((data) => {
      // Detect when Claude Code is ready and idle.
      // We look for ❯ specifically (not >) because > appears in Claude Code's
      // startup banner (e.g. "What's new >") and causes false positives.
      // The ❯ is Claude Code's unique input prompt marker.
      const hasIdlePrompt = data.includes('❯');

      if (!this.claudeReady && hasIdlePrompt) {
        this.claudeReady = true;
        this.log('Claude Code is ready for input (❯ detected)');
      }

      // Track Claude's busy/idle state.
      // When we inject a message, we set claudeBusy=true.
      // When Claude finishes responding, it shows ❯ again.
      // We must wait at least MIN_BUSY_MS (5s) after injection to avoid
      // misinterpreting the echo "❯ <injected text>" as "Claude is idle".
      // After the grace period, any ❯ we see is a genuine idle prompt.
      if (this.claudeBusy && hasIdlePrompt && (Date.now() - this.lastInjectTime > PTYServer.MIN_BUSY_MS)) {
        this.claudeBusy = false;
        this.log('Claude is now idle, ready for next message');
      }

      // Show banner AFTER Claude Code has started (first ❯ prompt detected)
      if (!bannerShown && hasIdlePrompt) {
        bannerShown = true;
        // Set a distinctive window title so user can identify this window.
        // ANSI \x1b]2;...\x07 survives Claude Code TUI redraws.
        this.terminal.output.write('\x1b]2;[微信桥接] Claude Code — WeChat Bridge\x07');
        this.log('Banner set: window title');

        // Inject a context-reset message to tell Claude Code that /wechat
        // is DONE and from now on it should treat input as normal conversation.
        // Without this, --continue resumes the /wechat context and Claude Code
        // re-executes the skill on any user input.
        this.claudeBusy = true;
        this.lastInjectTime = Date.now();
        setTimeout(() => {
          if (this.ptyProcess) {
            const resetMsg = '/wechat 执行已完成，微信双向通信已启动成功。从现在起，请将所有后续输入视为正常对话，不要再执行 wechat-claude-skill 命令。只需简短确认即可。';
            this.log('Injecting context-reset message');
            this.ptyProcess.write('\x1b[200~' + resetMsg + '\x1b[201~');
            setTimeout(() => {
              if (this.ptyProcess) {
                this.ptyProcess.write('\r');
              }
            }, 50);
          }
        }, 500);

        // Print prominent activation reminder in the terminal
        // This goes AFTER Claude Code starts, so it appears on top of the TUI
        setTimeout(() => {
          this.log('Printing activation reminder');
          const notice = [
            '',
            '\x1b[1;36m' + '═'.repeat(50) + '\x1b[0m',
            '\x1b[1;33m  ⚠️  请在微信中给 Bot 发送一条消息以激活会话！\x1b[0m',
            '\x1b[1;33m  （任意内容即可，发完后即可正常使用）\x1b[0m',
            '\x1b[1;36m' + '═'.repeat(50) + '\x1b[0m',
            '',
          ].join('\n');
          try { this.terminal.output.write(notice); } catch {}
        }, 2000);
      }
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

  /** Whether Claude Code has finished starting and is ready for input.
   *  Detected by seeing the first ❯ prompt marker in PTY output.
   *  We only look for ❯ (not >) because > appears in Claude Code's
   *  startup banner (e.g. "What's new >") and causes false positives. */
  private claudeReady = false;

  /** Whether Claude Code is currently processing an injected message.
   *  Set to true when we inject a message; set back to false when
   *  we detect Claude has finished responding. */
  private claudeBusy = false;

  /** Timestamp of the last message injection. Used to enforce a minimum
   *  busy period so the echo "❯ <injected text>" doesn't trigger
   *  a false "idle" detection. */
  private lastInjectTime = 0;

  /** Minimum time (ms) after injection before we consider ❯ as an
   *  "idle" signal. The echo "❯ <injected text>" appears almost instantly,
   *  but Claude takes at least a few seconds to start and finish thinking.
   *  After this grace period, any ❯ we see is a genuine idle prompt. */
  private static readonly MIN_BUSY_MS = 5000;

  private processQueue(): void {
    if (!this.running || !this.ptyProcess || this.options.queue.isEmpty) return;

    // Don't inject until Claude Code is ready (first ❯ prompt detected).
    if (!this.claudeReady) {
      this.log('Waiting for Claude Code to be ready before injecting...');
      return;
    }

    // Don't inject while Claude is busy processing a previous message.
    if (this.claudeBusy) {
      // This is normal — just wait for the next processQueue() cycle
      return;
    }

    // Inject only ONE message at a time, then wait for Claude to finish.
    // This prevents messages from being concatenated or lost.
    const pending = this.options.queue.dequeueAll();
    pending.sort((a, b) => a.timestamp - b.timestamp);
    const item = pending[0]; // Only inject the first (oldest) message

    // Put remaining messages back at the front of the queue
    if (pending.length > 1) {
      this.options.queue.requeue(pending.slice(1));
    }

    this.log(`Injecting WeChat message from ${item.from}: ${item.text}`);
    this.claudeBusy = true;
    this.lastInjectTime = Date.now();
    // Claude Code enables bracketed paste mode (\x1b[?2004h).
    // We must wrap injected text in paste escape sequences, otherwise
    // the text appears in the input box but \r doesn't trigger submission.
    // Format: \x1b[200~ <text> \x1b[201~ then send Enter separately.
    const text = item.text;
    this.ptyProcess.write('\x1b[200~' + text + '\x1b[201~');
    // Send Enter (\r = carriage return = Enter key) in a separate write
    // to ensure the paste is complete before submission.
    setTimeout(() => {
      if (this.ptyProcess) {
        this.ptyProcess.write('\r');
      }
    }, 50);
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
