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
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAccount } from './auth.js';
import { BRIDGE_DIR, DEFAULTS } from './config.js';
import { startMessagePolling, sendMessage, type WeChatMessage } from './wechat.js';
import { MessageQueue } from './queue.js';
import { PTYServer } from './pty-server.js';

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
function parseArgs(): { mode: 'cli' | 'vscode'; sessionId?: string; cwd: string } {
  const args = process.argv.slice(2);
  let mode: 'cli' | 'vscode' = 'cli';
  let sessionId: string | undefined;
  let cwd = process.cwd();

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--mode': mode = args[++i] as any; break;
      case '--session': sessionId = args[++i]; break;
      case '--cwd': cwd = args[++i]; break;
    }
  }
  return { mode, sessionId, cwd };
}

// Format message for WeChat display
function formatForWeChat(message: string): string {
  // Truncate very long messages
  const maxLen = 4000;
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
  const { mode, sessionId, cwd } = parseArgs();
  log(`Starting in ${mode} mode, cwd=${cwd}, session=${sessionId || 'none'}`);

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
      }
      res.json({ mode, ok: true });
      return;
    }

    // CLI mode or full message: send to WeChat
    if (message && config.toUserId) {
      const formatted = formatForWeChat(message);
      log(`Attempting to send to WeChat: ${formatted.slice(0, 80)}...`);
      log(`Config: botToken=${config.botToken?.slice(0, 10)}..., toUserId=${config.toUserId}`);
      const result = await sendMessage(config, config.toUserId, formatted);
      log(`sendMessage result: ${JSON.stringify(result)}`);
      if (result.success) {
        log(`Sent to WeChat: ${formatted.slice(0, 80)}...`);
      } else {
        logError(`WeChat send failed: ${result.error}`);
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

    // Save PID
    mkdirSync(BRIDGE_DIR, { recursive: true });
    writeFileSync(join(BRIDGE_DIR, 'bridge.pid'), String(process.pid), 'utf-8');
  });

  // Start WeChat message polling
  const poller = startMessagePolling(
    config,
    (messages: WeChatMessage[]) => {
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
      logError(`Poll error: ${error.message}`);
    },
  );

  // CLI mode: start PTY server
  let ptyServer: PTYServer | null = null;
  if (mode === 'cli' && sessionId) {
    ptyServer = new PTYServer({
      sessionId,
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
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

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
