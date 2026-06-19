/**
 * Stop hook handler.
 *
 * Triggered by Claude Code's Stop event (fires when Claude finishes responding).
 * Reads `last_assistant_message` from stdin and sends it to WeChat.
 *
 * Works for both VSCode and CLI modes:
 * - VSCode: one-way notification (Claude → WeChat)
 * - CLI: one-way notification here; bridge handles WeChat → Claude via PTY
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
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAccount } from './auth.js';
import { sendMessage } from './wechat.js';
import type { BridgeConfig } from './config.js';

const LOG_FILE = join(homedir(), '.wechat-claude-skill', 'hook-handler.log');
const MAX_MESSAGE_LENGTH = 4000;

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

  // Try getUpdates first — two purposes:
  // 1. Fetch a real context_token from any prior user message (opportunistic).
  //    context_token is NOT required (empty/fake values also work), but a real
  //    one from getUpdates is the "cleanest" parameter to pass.
  // 2. The getUpdates call itself does NOT activate the Bot — the only thing
  //    that activates a newly-bound Bot is the user sending a message first.
  //    If this is a new account with no user messages yet, sendMessage will
  //    likely return ret:-2 and the message won't be delivered.
  let contextToken = '';
  const API_BASE = account.baseUrl || 'https://ilinkai.weixin.qq.com';
  const randBuf = new Uint8Array(4);
  crypto.getRandomValues(randBuf);
  const uin = Buffer.from(randBuf).toString('base64');
  try {
    const pollRes = await fetch(`${API_BASE}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${account.botToken}`,
        'AuthorizationType': 'ilink_bot_token',
        'X-WECHAT-UIN': uin,
      },
      body: JSON.stringify({}),
    });
    const pollData = await pollRes.json();
    // Extract context_token from the latest user message, if any
    const msgs = pollData.msgs || [];
    for (const msg of msgs) {
      if (msg.context_token) {
        contextToken = msg.context_token;
        break;
      }
    }
    debugLog(`getUpdates: ret=${pollData.ret} errcode=${pollData.errcode} msgs=${msgs.length} ctx=${contextToken ? 'YES' : 'NO'}`);
  } catch (e: any) {
    debugLog(`getUpdates failed (non-fatal): ${e.message}`);
  }

  // Truncate if too long
  const text = message.length > MAX_MESSAGE_LENGTH
    ? message.slice(0, MAX_MESSAGE_LENGTH) + '\n\n... (消息过长，已截断)'
    : message;

  // Send to WeChat — context_token is optional (see file header comment #2)
  debugLog('Sending to WeChat...');
  const result = await sendMessage(config, account.userId, text, contextToken || undefined);

  if (result.success) {
    debugLog(`Sent successfully (msgId: ${result.msgId || 'unknown'})`);
  } else {
    debugLog(`Send failed: ${result.error}`);
  }

  process.exit(0);
}

main();
