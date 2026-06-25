/**
 * Bridge entry point.
 *
 * Runs as a detached background process. Two modes:
 * - CLI mode: HTTP server + PTY (wraps Claude Code)
 * - VSCode mode: HTTP server only (hooks call hook-handler)
 *
 * Usage: node bridge.js --mode cli|vscode [--session <id>] [--cwd <dir>]
 *
 * Note: Since the bridge runs detached, stdout/stdin are piped.
 * Logs go to ~/.wechat-claude-skill/bridge.log
 * PTY output goes directly to the terminal device (handled by PTYServer).
 */

import express from 'express';
import { writeFileSync, appendFileSync, mkdirSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAccount } from './auth.js';
import { BRIDGE_DIR, DEFAULTS } from './config.js';
import { startMessagePolling, sendMessage, type WeChatMessage } from './wechat.js';
import { MessageQueue } from './queue.js';
import { PTYServer } from './pty-server.js';
import { showDisconnectToast } from './notify.js';
import { splitMessage } from './split-message.js';

const LOG_FILE = join(BRIDGE_DIR, 'bridge.log');

// Log to file (since stdout is piped, not terminal)
function log(msg: string): void {
  const now = new Date();
  const ts = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const line = `[${ts}] ${msg}\n`;
  try {
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {}
}

function logError(msg: string): void {
  log(`ERROR: ${msg}`);
}

// Parse CLI arguments
function parseArgs(): { mode: 'cli' | 'vscode'; sessionId?: string; cwd: string; launcherPid?: number } {
  const args = process.argv.slice(2);
  let mode: 'cli' | 'vscode' = 'cli';
  let sessionId: string | undefined;
  let cwd = process.cwd();
  let launcherPid: number | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--mode': mode = args[++i] as any; break;
      case '--session': sessionId = args[++i]; break;
      case '--cwd': cwd = args[++i]; break;
      case '--launcher-pid': launcherPid = parseInt(args[++i], 10); break;
    }
  }
  return { mode, sessionId, cwd, launcherPid };
}

// Truncate very long messages for WeChat display (used only for short notifications)
function truncateForWeChat(message: string, maxLen = 4000): string {
  if (message.length > maxLen) {
    return message.slice(0, maxLen) + '\n\n... (消息过长，已截断)';
  }
  return message;
}

// Format WeChat message for Claude injection (CLI mode)
function formatForClaude(msg: WeChatMessage): string {
  const time = new Date(msg.createTime || Date.now())
    .toLocaleTimeString('zh-CN', { hour12: false });
  return `[微信消息 ${time} from ${msg.fromNickname || msg.fromUserId}]：${msg.text}`;
}

async function main() {
  const { mode, sessionId, cwd, launcherPid } = parseArgs();
  log(`Starting in ${mode} mode, cwd=${cwd}, session=${sessionId || 'none'}, launcherPid=${launcherPid || 'none'}`);

  // Load account data (from QR login)
  const account = loadAccount();
  if (!account) {
    logError('No account found. Run setup first.');
    process.exit(1);
  }

  const config = {
    botToken: account.botToken,
    accountId: account.accountId,
    toUserId: account.userId,  // send back to the person who scanned
    baseUrl: account.baseUrl,
    port: DEFAULTS.port,
    pollInterval: DEFAULTS.pollInterval,
  };

  log(`Account: ${account.accountId}, toUserId: ${config.toUserId}`);
  const queue = new MessageQueue();
  let activated = false;  // Track if any user message has been received
  let consecutiveSendErrors = 0;  // Consecutive sendMessage failures with errcode=-14
  let halfDisconnected = false;   // Whether we've already shown the disconnect toast
  const HALF_DISCONNECT_THRESHOLD = 3;  // 3 consecutive -14 errors = half-disconnect

  /** Check sendMessage result for half-disconnect pattern (errcode=-14).
   *  After 3 consecutive -14 errors, show a toast notification once.
   *  Resets on any successful send. */
  const checkHalfDisconnect = (result: { success: boolean; error?: string }) => {
    if (result.success) {
      if (consecutiveSendErrors > 0 || halfDisconnected) {
        log('sendMessage recovered, resetting half-disconnect state');
      }
      consecutiveSendErrors = 0;
      halfDisconnected = false;
      return;
    }
    // Only count -14 / session_expired as half-disconnect signal
    const isSessionExpired = result.error?.includes('session_expired') ||
      result.error?.includes('errcode=-14');
    if (isSessionExpired) {
      consecutiveSendErrors++;
      log(`Half-disconnect check: consecutiveSendErrors=${consecutiveSendErrors}/${HALF_DISCONNECT_THRESHOLD}`);
      if (consecutiveSendErrors >= HALF_DISCONNECT_THRESHOLD && !halfDisconnected) {
        halfDisconnected = true;
        log('Half-disconnect detected: showing toast notification');
        showDisconnectToast();
      }
    }
  };

  // Create Express app
  const app = express();
  // Force UTF-8 encoding for all requests
  app.use((req, _res, next) => {
    if (!req.headers['content-type']?.includes('charset')) {
      req.headers['content-type'] = `${req.headers['content-type'] || 'application/json'}; charset=utf-8`;
    }
    next();
  });
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode, queueLength: queue.length, activated });
  });

  // Stop hook endpoint - receives Claude's response
  app.post('/hooks/stop', async (req, res) => {
    const { message, session_id } = req.body;
    log(`Stop hook: session=${session_id}, msgLen=${message?.length || 0}`);

    // VSCode mode: message is just "stop" notification, send brief notification
    if (message === 'stop' && mode === 'vscode') {
      log('VSCode mode: sending stop notification');
      if (config.toUserId) {
        const result = await sendMessage(config, config.toUserId, '💬 Claude 已回复');
        log(`Notification result: ${JSON.stringify(result)}`);
        checkHalfDisconnect(result);
      }
      res.json({ mode, ok: true });
      return;
    }

    // CLI mode or full message: send to WeChat (split if too long)
    if (message && config.toUserId) {
      const chunks = splitMessage(message);
      log(`Message split into ${chunks.length} chunks (original length: ${message.length})`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        log(`Sending chunk ${i + 1}/${chunks.length}: ${chunk.slice(0, 80)}...`);
        const result = await sendMessage(config, config.toUserId, chunk);
        log(`Chunk ${i + 1}/${chunks.length} result: ${JSON.stringify(result)}`);

        if (result.success) {
          log(`Sent chunk ${i + 1}/${chunks.length} to WeChat`);
        } else {
          logError(`Chunk ${i + 1}/${chunks.length} send failed: ${result.error}`);
        }
        checkHalfDisconnect(result);
      }
    }

    res.json({ mode, ok: true });
  });

  // Start HTTP server
  const port = config.port || 3456;
  const server = app.listen(port, '127.0.0.1', () => {
    log(`HTTP server listening on port ${port}`);

    // Signal readiness to parent process (via stdout pipe)
    process.stdout.write(`BRIDGE_READY:${process.pid}\n`);

    // Save PID and state (so hook-handler can detect CLI mode)
    mkdirSync(BRIDGE_DIR, { recursive: true });
    writeFileSync(join(BRIDGE_DIR, 'bridge.pid'), String(process.pid), 'utf-8');
    // Write state.json for hook-handler's isCliModeActive() check
    writeFileSync(join(BRIDGE_DIR, 'state.json'), JSON.stringify({
      mode,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      sessionId: sessionId || undefined,
      cwd,
    }, null, 2) + '\n', 'utf-8');
    log(`State saved: mode=${mode}, pid=${process.pid}`);
  });

  // Start WeChat message polling
  let consecutivePollErrors = 0;
  let autoUnbound = false;
  const MAX_CONSECUTIVE_ERRORS = 5;  // After 5 consecutive failures, assume token is invalid

  // Auto-unbind: delete account.json + remove hook + cleanup state + shutdown
  const autoUnbind = (reason: string) => {
    if (autoUnbound) return;
    autoUnbound = true;
    log(`Auto-unbind triggered: ${reason}`);

    // 1. Delete account.json (token is invalid, useless)
    const accountPath = join(BRIDGE_DIR, 'account.json');
    try { unlinkSync(accountPath); log('Deleted account.json'); } catch {}

    // 2. Remove hook config from settings.json
    try {
      const settingsPath = join(homedir(), '.claude', 'settings.json');
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        if (settings.hooks) {
          for (const eventName of Object.keys(settings.hooks)) {
            const entries = settings.hooks[eventName];
            if (!Array.isArray(entries)) continue;
            settings.hooks[eventName] = entries.filter((entry: any) =>
              !entry.hooks?.some((h: any) =>
                (h.command && h.command.includes('hook-handler')) ||
                (h.args && h.args.some((a: string) => a.includes('hook-handler')))
              )
            );
            if (settings.hooks[eventName].length === 0) delete settings.hooks[eventName];
          }
          if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
          log('Removed hook-handler from settings.json');
        }
      }
    } catch (e: any) { logError(`Failed to remove hook config: ${e.message}`); }

    // 3. Cleanup state files
    try { unlinkSync(join(BRIDGE_DIR, 'state.json')); } catch {}
    try { unlinkSync(join(BRIDGE_DIR, 'bridge.pid')); } catch {}
    try { unlinkSync(join(BRIDGE_DIR, 'pty.pid')); } catch {}

    // 4. Show prompt to user
    const msg = '\n\n⚠️ 微信绑定已失效，已自动解绑。请执行 /wechat 重新绑定。\n';
    if (mode === 'cli') {
      try { process.stdout.write(msg); } catch {}
    }
    log('⚠️ 微信绑定已失效，已自动解绑。请执行 /wechat 重新绑定。');

    // 5. Shutdown
    shutdown();
  };

  const poller = startMessagePolling(
    config,
    (messages: WeChatMessage[]) => {
      consecutivePollErrors = 0;  // Reset on success
      log(`Received ${messages.length} messages from polling`);
      for (const msg of messages) {
        log(`  msg: isSystem=${msg.isSystem} isBot=${msg.isBot} text=${msg.text?.slice(0, 50)}`);
        if (msg.isSystem || msg.isBot) continue;

        activated = true;  // Mark as activated when first user message is received

        const enqueued = queue.enqueue({
          msgId: msg.msgId,
          from: msg.fromNickname || msg.fromUserId,
          text: formatForClaude(msg),
          timestamp: msg.createTime || Date.now(),
        });

        if (enqueued) {
          log(`Queued WeChat message from ${msg.fromNickname}: ${msg.text.slice(0, 80)}`);
        }
      }
    },
    (error) => {
      consecutivePollErrors++;
      logError(`Poll error (${consecutivePollErrors}/${MAX_CONSECUTIVE_ERRORS}): ${error.message}`);
      if (consecutivePollErrors >= MAX_CONSECUTIVE_ERRORS) {
        autoUnbind(`连续 ${MAX_CONSECUTIVE_ERRORS} 次轮询失败，token 可能已失效`);
      }
    },
    () => {
      autoUnbind('微信会话已过期 (errcode=-14)');
    },
  );

  // CLI mode: start PTY server (with or without sessionId)
  let ptyServer: PTYServer | null = null;
  if (mode === 'cli') {
    ptyServer = new PTYServer({
      sessionId: sessionId || '',  // Empty string = use --continue instead of --resume
      cwd,
      config,
      queue,
      onResponse: () => {
        // PTY output is displayed to user by PTYServer directly
      },
      onError: (error) => {
        logError(`PTY error: ${error.message}`);
      },
    });
    ptyServer.start();
  }

  // Graceful shutdown
  const shutdown = () => {
    log('Shutting down...');
    poller.stop();
    ptyServer?.stop();
    server.close();
    // On Windows, node-pty's ConPTY can prevent process.exit() from working.
    // Force kill ourselves after cleanup.
    setTimeout(() => {
      try { process.kill(process.pid, 'SIGKILL'); } catch {}
    }, 1000);
    process.exitCode = 0;
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Monitor launcher process: if the CMD window (cli-launcher.js) closes,
  // bridge should exit too. This prevents orphaned bridge processes.
  if (launcherPid) {
    const watch = setInterval(() => {
      try {
        process.kill(launcherPid, 0);  // throws if process is dead
      } catch {
        log(`Launcher process ${launcherPid} is dead, shutting down`);
        clearInterval(watch);
        shutdown();
      }
    }, 3000);
  }

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logError(`Uncaught exception: ${error.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    logError(`Unhandled rejection: ${String(reason)}`);
  });
}

main().catch((error) => {
  console.error('[Bridge] Fatal error:', error);
  process.exit(1);
});
