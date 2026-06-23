/**
 * WeChat iLink QR code login.
 *
 * Reuses the same iLink API as wechat-claude-code.
 * Saves account data to ~/.wechat-claude-skill/account.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, exec } from 'node:child_process';

const BRIDGE_DIR = join(homedir(), '.wechat-claude-skill');
const ACCOUNT_PATH = join(BRIDGE_DIR, 'account.json');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QR_CODE_URL = `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
const QR_STATUS_URL = `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status`;
const POLL_INTERVAL_MS = 1_000;

export interface AccountData {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId: string;
  createdAt: string;
}

interface QrCodeResponse {
  ret: number;
  qrcode?: string;
  qrcode_img_content?: string;
}

interface QrStatusResponse {
  ret: number;
  status: string;
  retmsg?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Save account data to disk. */
export function saveAccount(data: AccountData): void {
  mkdirSync(BRIDGE_DIR, { recursive: true });
  writeFileSync(ACCOUNT_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** Load saved account data. Returns null if not found. */
export function loadAccount(): AccountData | null {
  if (!existsSync(ACCOUNT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ACCOUNT_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/** Phase 1: Request a QR code for login. Returns the URL and ID. */
export async function startQrLogin(): Promise<{ qrcodeUrl: string; qrcodeId: string }> {
  const res = await fetch(QR_CODE_URL);
  if (!res.ok) {
    throw new Error(`Failed to get QR code: HTTP ${res.status}`);
  }

  const data = (await res.json()) as QrCodeResponse;

  if (data.ret !== 0 || !data.qrcode_img_content || !data.qrcode) {
    throw new Error(`Failed to get QR code (ret=${data.ret})`);
  }

  return {
    qrcodeUrl: data.qrcode_img_content,
    qrcodeId: data.qrcode,
  };
}

/**
 * Phase 2: Wait for the user to scan and confirm the QR code.
 * Throws on expiry so the caller can regenerate.
 * Returns the full AccountData on success.
 */
export async function waitForQrScan(qrcodeId: string): Promise<AccountData | 'RETRY'> {
  let lastStatus = '';
  let pollCount = 0;
  while (true) {
    const url = `${QR_STATUS_URL}?qrcode=${encodeURIComponent(qrcodeId)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === 'AbortError' || e.code === 'ETIMEDOUT') {
        continue; // retry
      }
      throw e;
    }
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Failed to check QR status: HTTP ${res.status}`);
    }

    const data = (await res.json()) as QrStatusResponse;

    switch (data.status) {
      case 'wait': {
        if (lastStatus !== 'wait') {
          console.log('⏳ 等待扫码...');
          lastStatus = 'wait';
        }
        break;
      }
      case 'scaned': {
        if (lastStatus !== 'scaned') {
          console.log('📱 已扫描！请在手机上点击确认...');
          lastStatus = 'scaned';
        }
        break;
      }

      case 'confirmed': {
        if (!data.bot_token || !data.ilink_bot_id || !data.ilink_user_id) {
          throw new Error('QR confirmed but missing required fields');
        }

        const accountData: AccountData = {
          botToken: data.bot_token,
          accountId: data.ilink_bot_id,
          baseUrl: data.baseurl || DEFAULT_BASE_URL,
          userId: data.ilink_user_id,
          createdAt: new Date().toISOString(),
        };

        saveAccount(accountData);
        return accountData;
      }

      case 'expired':
        throw new Error('QR code expired');

      default: {
        const status = data.status ?? '';
        if (status.includes('not_support') || status.includes('forbid') || status.includes('reject')) {
          // Return special signal instead of throwing — let caller decide to retry
          return 'RETRY' as any;
        }
        // Unknown status — show it to the user
        if (status && status !== lastStatus) {
          console.log(`⚠️ 未知扫码状态: ${status} ${data.retmsg || ''}`);
          lastStatus = status;
        }
        break;
      }
    }

    pollCount++;
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Interactive QR login: display QR code in terminal, wait for scan.
 * Auto-regenerates QR when expired.
 * Auto-opens QR code image in browser for easy scanning.
 * Returns AccountData on success.
 *
 * IMPORTANT: The QR code URL (qrcode_img_content) is a link like
 * https://liteapp.weixin.qq.com/q/... which shows a QR image in the browser.
 * WeChat scans this image. If the browser fails to load (network error),
 * the user can still scan the terminal ASCII QR code.
 */
export async function interactiveLogin(): Promise<AccountData> {
  let browserOpened = false;
  let retryCount = 0;
  const MAX_RETRIES = 3;

  while (retryCount < MAX_RETRIES) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    console.log('\n请用微信扫描二维码绑定 Bot：\n');

    // Show terminal ASCII QR code (always up-to-date on each refresh)
    try {
      const qrcodeTerminal = await import('qrcode-terminal');
      qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
      console.log();
    } catch {
      console.log(`二维码链接：${qrcodeUrl}\n`);
    }

    // Only open browser on the FIRST attempt ever.
    // On QR refresh, the browser tab still shows the old QR — user should
    // scan the terminal ASCII QR code instead, or manually refresh the browser.
    if (!browserOpened) {
      browserOpened = true;
      try {
        if (process.platform === 'win32') {
          // Use exec + shell to open URL — most reliable on Windows.
          // spawn('cmd', ['/c', 'start', ...]) fails because cmd's start command
          // misparses quoted URLs with & characters.
          exec(`start "" "${qrcodeUrl}"`);
        } else {
          spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [qrcodeUrl], { detached: true, stdio: 'ignore' }).unref();
        }
        console.log('📱 已在浏览器中打开二维码，请用微信扫描');
      } catch {
        console.log(`📱 请复制链接到浏览器打开：${qrcodeUrl}`);
      }
    } else {
      console.log('💡 二维码已刷新，请扫描上方终端二维码（或手动刷新浏览器页面）');
    }

    console.log('\n等待扫码（按 Ctrl+C 取消）...');

    try {
      const result = await waitForQrScan(qrcodeId);
      if (result === 'RETRY') {
        // Scan failed (reject/forbid) — retry with fresh QR
        retryCount++;
        console.log(`\n⚠️ 扫码失败（${retryCount}/${MAX_RETRIES}），正在重新生成二维码...`);
        continue;
      }
      return result as AccountData;
    } catch (e: any) {
      if (e.message?.includes('expired')) {
        // QR expired — don't count as a failed scan, just regenerate
        console.log('\n⏰ 二维码已过期，正在重新生成...\n');
        continue;
      }
      throw e;
    }
  }

  throw new Error(`扫码重试已达上限（${MAX_RETRIES}次），请重新执行 /wechat`);
}
