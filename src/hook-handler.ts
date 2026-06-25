/**
 * Stop hook handler.
 *
 * Triggered by Claude Code's Stop event (fires when Claude finishes responding).
 * Reads `last_assistant_message` from stdin and sends it to WeChat.
 *
 * Works for both VSCode and CLI modes:
 * - VSCode: one-way notification (Claude → WeChat)
 * - CLI: hook-handler detects CLI mode and exits early (bridge handles messages via PTY)
 *
 * Exit 0: normal exit, Claude stays stopped (ready for next user input)
 *
 * ## iLink sendMessage 关键结论 (2026-06-20 验证)
 *
 * 1. 新扫码绑定的 Bot，用户必须先发一条消息给 Bot，sendMessage 才能成功投递。
 *    在此之前 sendMessage 返回 ret:-2，微信收不到消息。
 *
 * 2. context_token 无关紧要 — 不传、传空字符串、传编造的值，都能发送成功。
 *    只要用户先发过消息激活了 Bot，sendMessage 就能工作。
 *
 * 3. getUpdates 预热不能替代"用户先发消息" — 仅调用 getUpdates 无法激活 Bot。
 *
 * 4. 微信二维码只有约 1 分钟有效期，过期需重新生成。
 *
 * 5. curl 发送中文会乱码（Windows 终端编码问题），Node.js fetch 默认 UTF-8 正常。
 *
 * ## hook-handler 与 bridge 的关系
 *
 * - VSCode 模式：hook-handler 直接发送消息到微信（bridge 仅做后台轮询）
 * - CLI 模式：bridge 通过 PTY 输出捕获 Claude 回复并发送到微信，
 *   hook-handler 检测到 CLI 模式后直接退出，避免同一条回复被发送两次。
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAccount } from './auth.js';
import { sendMessage } from './wechat.js';
import { splitMessage } from './split-message.js';
import type { BridgeConfig } from './config.js';

const LOG_FILE = join(homedir(), '.wechat-claude-skill', 'hook-handler.log');
const BRIDGE_DIR = join(homedir(), '.wechat-claude-skill');

function debugLog(msg: string): void {
  const now = new Date();
  const beijingTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  try { appendFileSync(LOG_FILE, `[${beijingTime}] ${msg}\n`); } catch {}
}

async function readStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  // Log immediately — proves the hook was triggered
  debugLog('=== Hook triggered ===');

  // CLI mode also uses this hook to send Claude's clean last_assistant_message.
  // PTY output contains TUI redraws/spinners/ANSI escapes, so bridge does NOT
  // forward raw PTY output to WeChat. Do not skip when CLI bridge is active.

  // Read hook input from stdin
  const inputStr = await readStdin();
  debugLog(`stdin length: ${inputStr.length}`);

  let hookInput: any = {};
  try { hookInput = JSON.parse(inputStr); } catch {
    debugLog('Failed to parse stdin as JSON, continuing');
  }

  // Use last_assistant_message from hook input (provided by Claude Code)
  const message: string | undefined = hookInput.last_assistant_message;
  if (!message || !message.trim()) {
    debugLog('No assistant message in hook input, exiting');
    process.exit(0);
  }

  debugLog(`Message length: ${message.length}`);

  // Load account
  const account = loadAccount();
  if (!account) {
    debugLog('No account found, exiting');
    process.exit(0);
  }

  const config: BridgeConfig = {
    botToken: account.botToken,
    accountId: account.accountId,
    toUserId: account.userId,
    baseUrl: account.baseUrl,
    port: 3456,
    pollInterval: 3000,
  };

  // Split long messages into chunks (preserves markdown formatting)
  const chunks = splitMessage(message);
  debugLog(`Message split into ${chunks.length} chunks (original length: ${message.length})`);

  // Send each chunk to WeChat — context_token is NOT required (see file header comment #2).
  for (let i = 0; i < chunks.length; i++) {
    debugLog(`Sending chunk ${i + 1}/${chunks.length}...`);
    const result = await sendMessage(config, account.userId, chunks[i]);

    if (result.success) {
      debugLog(`Chunk ${i + 1}/${chunks.length} sent successfully (msgId: ${result.msgId || 'unknown'})`);
    } else {
      debugLog(`Chunk ${i + 1}/${chunks.length} send failed: ${result.error}`);
    }
  }

  process.exit(0);
}

main();
