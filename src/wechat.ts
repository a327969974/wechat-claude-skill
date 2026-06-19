/**
 * WeChat iLink Bot API client.
 *
 * Wraps the iLink API for:
 * - Sending text messages (with rate limiting + retry)
 * - Polling for new messages (long-poll, with dedup + backoff)
 *
 * Optimizations ported from wechat-claude-code:
 * - Per-user send rate limiting (2500ms interval)
 * - Exponential backoff retry on ret=-2
 * - Message deduplication (Set of 1000 IDs)
 * - Poll error backoff (3s → 30s)
 * - Session expiry detection (ret=-14)
 * - Sync buffer persistence
 * - Abortable sleep
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BridgeConfig } from './config.js';

const API_TIMEOUT_MS = 15_000;
const POLL_TIMEOUT_MS = 30_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// Message types
const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_TYPE_SYS = 3;

// Item types
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_FILE = 4;
const ITEM_LINK = 10;
const ITEM_CARD = 17;

// Message states
const MSG_STATE_TYPING = 1;
const MSG_STATE_FINISH = 2;

// User roles
const ROLE_MEMBER = 2;
const ROLE_OWNER = 3;

// Rate limit constants (from wechat-claude-code)
const MIN_SEND_INTERVAL_MS = 2_500;
const SEND_MAX_RETRIES = 3;  // 3s → 6s → 12s
const SEND_RETRY_DELAY_MS = 3_000;
const SEND_RETRY_MAX_DELAY_MS = 15_000;

// Poll backoff constants (from wechat-claude-code)
const BACKOFF_THRESHOLD = 3;
const BACKOFF_SHORT_MS = 3_000;
const BACKOFF_LONG_MS = 30_000;

// Session expiry
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_EXPIRED_PAUSE_MS = 60 * 60 * 1_000;
const RATE_LIMIT_ERRCODE = -2;

/** Detect stale session.
 *  Based on hermes-agent implementation:
 *  - errcode=-14 (SESSION_EXPIRED_ERRCODE) = session expired
 *  - ret=-2 (RATE_LIMIT_ERRCODE) = rate-limited, NOT session expired
 *  Previously ret=-2 without errmsg was misidentified as session expired,
 *  causing sendMessage to fail prematurely instead of retrying as rate-limited. */
function isStaleSession(ret?: number, errcode?: number, errmsg?: string): boolean {
  // Only errcode=-14 indicates session expiry; ret=-2 is rate-limited
  if (errcode === SESSION_EXPIRED_ERRCODE) return true;
  return false;
}

// Message dedup
const MAX_RECENT_MSG_IDS = 1_000;

// Sync buffer persistence
const SYNC_BUF_DIR = join(homedir(), '.wechat-claude-skill');
const SYNC_BUF_PATH = join(SYNC_BUF_DIR, 'sync_buf.json');

export interface WeChatMessage {
  msgId: string;
  fromUserId: string;
  fromNickname: string;
  fromRole: number;
  text: string;
  msgType: number;
  createTime: number;
  isSystem: boolean;
  isBot: boolean;
  mentionsMe: boolean;
  contextToken?: string;
}

interface LongPollResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msg_list?: any[];
  continue_flag?: number;
  selector?: number;
  svr_time?: number;
  get_updates_buf?: string;
}

// --- Utilities ---

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function generateUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64');
}

function generateMsgId(): string {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 100000);
  return `${ts}${String(rand).padStart(5, '0')}`;
}

// --- Sync buffer persistence ---

function loadSyncBuf(): any {
  try {
    if (existsSync(SYNC_BUF_PATH)) {
      return JSON.parse(readFileSync(SYNC_BUF_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveSyncBuf(buf: any): void {
  try {
    mkdirSync(SYNC_BUF_DIR, { recursive: true });
    writeFileSync(SYNC_BUF_PATH, JSON.stringify({ get_updates_buf: buf }), 'utf-8');
  } catch {}
}

// --- Message parsing ---

function parseMessage(raw: any): WeChatMessage | null {
  const msgType = raw?.msg_type ?? raw?.message_type;
  if (msgType === undefined || msgType === null) return null;

  const msgId =
    raw?.msg_id || raw?.newMsgId || raw?.msgid || raw?.tempMsgId || generateMsgId();

  const fromUserId = String(raw?.from_user_id || '');
  const fromNickname = String(raw?.from_nickname || '');
  const fromRole = raw?.from_role === ROLE_OWNER ? ROLE_OWNER : ROLE_MEMBER;
  const createTime = Number(raw?.create_time || 0);
  const contextToken = raw?.context_token || undefined;
  const isSystem = msgType === MSG_TYPE_SYS;

  let text = '';
  let mentionsMe = false;

  if (msgType === MSG_TYPE_USER || msgType === MSG_TYPE_BOT || msgType === MSG_TYPE_SYS) {
    const items = raw?.item_list;
    if (Array.isArray(items)) {
      for (const item of items) {
        const itemType = item?.type;
        if (itemType === ITEM_TEXT) {
          const content: string = item?.text_item?.content || item?.text_item?.text || '';
          if (content) { if (text) text += '\n'; text += content; }
        } else if (itemType === ITEM_CARD) {
          const title = item?.card_item?.title || '';
          const desc = item?.card_item?.desc || item?.card_item?.description || '';
          if (title || desc) { if (text) text += '\n'; text += `【卡片】${title}${desc ? ': ' + desc : ''}`; }
        } else if (itemType === ITEM_LINK) {
          const title = item?.link_item?.title || '';
          const url = item?.link_item?.link || '';
          if (title || url) { if (text) text += '\n'; text += `【链接】${title}${url ? ': ' + url : ''}`; }
        } else if (itemType === ITEM_IMAGE) {
          if (text) text += '\n'; text += '【图片】';
        } else if (itemType === ITEM_FILE) {
          const fileName = item?.file_item?.name || '文件';
          if (text) text += '\n'; text += `【文件: ${fileName}】`;
        }
      }
    }
    if (!text) text = raw?.text || raw?.content || raw?.msg || '';

    const atList: any[] = raw?.at_list || [];
    const myUserId = raw?.my_user_id || raw?.to_user_id || '';
    if (atList.length > 0 && myUserId) {
      for (const at of atList) {
        if (at?.at_user_id && at.at_user_id === myUserId) { mentionsMe = true; break; }
      }
    }
  }

  text = (text || '').replace(/@imᐝ/g, '').trim();
  if (!text && !isSystem) return null;

  return {
    msgId: String(msgId), fromUserId, fromNickname, fromRole,
    text, msgType, createTime, isSystem,
    isBot: msgType === MSG_TYPE_BOT, mentionsMe, contextToken,
  };
}

function parseMessagesFromResponse(json: any): WeChatMessage[] {
  const messages: WeChatMessage[] = [];
  const msgList = json?.msgs || json?.msg_list;
  if (!Array.isArray(msgList)) return messages;
  for (const raw of msgList) {
    try { const msg = parseMessage(raw); if (msg) messages.push(msg); } catch {}
  }
  return messages;
}

function tryExtractMyUserId(json: any): string | undefined {
  const msgList = json?.msgs || json?.msg_list;
  if (!Array.isArray(msgList)) return undefined;
  for (const raw of msgList) { const myId = raw?.my_user_id; if (myId) return String(myId); }
  return undefined;
}

// --- HTTP helpers ---

async function makeFetchInit(
  method: string, config: BridgeConfig,
  extraHeaders?: Record<string, string>, body?: any,
): Promise<RequestInit> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN',
    'Origin': config.baseUrl,
    'Referer': `${config.baseUrl}/`,
    'Authorization': `Bearer ${config.botToken}`,
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': generateUin(), // Fresh UIN per request
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '131584', // (2<<16)|(2<<8)|0
    ...extraHeaders,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  return init;
}

async function apiPost(
  config: BridgeConfig, endpoint: string, payload: any,
  extraHeaders?: Record<string, string>, timeoutMs = API_TIMEOUT_MS,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Add base_info like hermes-agent does
    const fullPayload = { ...payload, base_info: { channel_version: '2.2.0' } };
    const init = await makeFetchInit('POST', config, extraHeaders, fullPayload);
    (init as any).signal = controller.signal;
    const resp = await fetch(`${config.baseUrl}/${endpoint}`, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return await resp.json();
  } finally { clearTimeout(timer); }
}

// --- Per-user send rate limiter ---

const nextSendTime = new Map<string, number>();

async function sendMessageWithRateLimit(
  config: BridgeConfig,
  to: string,
  text: string,
  contextToken?: string,
): Promise<{ success: boolean; error?: string; msgId?: string }> {
  if (!text?.trim()) return { success: false, error: 'text is empty' };

  // Per-user rate limiting: ensure MIN_SEND_INTERVAL_MS between sends
  const now = Date.now();
  const nextAvailable = (nextSendTime.get(to) ?? 0) + MIN_SEND_INTERVAL_MS;
  const sendAt = Math.max(now, nextAvailable);
  nextSendTime.set(to, sendAt);
  const waitMs = sendAt - now;
  if (waitMs > 0) await sleep(waitMs);

  const message: any = {
    from_user_id: config.accountId,
    to_user_id: to,
    client_id: `wcc-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [{ type: ITEM_TEXT, text_item: { text } }],
  };
  if (contextToken) message.context_token = contextToken;

  // Retry with exponential backoff on ret=-2
  let delay = SEND_RETRY_DELAY_MS;
  let retriedWithoutCtx = false;
  for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
    try {
      const json = await apiPost(config, 'ilink/bot/sendmessage', { msg: message });
      const ret = json?.ret;
      const errcode = json?.errcode;
      const errmsg = json?.errmsg;

      // Success: {} or { ret: 0 } AND no error code
      if ((ret === undefined || ret === 0) && (errcode === undefined || errcode === 0)) {
        return { success: true, msgId: json?.resp?.msg_id || json?.msg_id };
      }

      // Session expired (errcode=-14 or stale session): strip context_token and retry once
      if (errcode === SESSION_EXPIRED_ERRCODE || isStaleSession(ret, errcode, errmsg)) {
        if (!retriedWithoutCtx && message.context_token) {
          retriedWithoutCtx = true;
          delete message.context_token;
          continue;
        }
        return { success: false, error: `session_expired: ret=${ret} errcode=${errcode}` };
      }

      // Rate limited: retry with backoff
      if (ret === RATE_LIMIT_ERRCODE) {
        nextSendTime.set(to, Date.now() + delay + MIN_SEND_INTERVAL_MS);
        if (attempt === SEND_MAX_RETRIES) {
          return { success: false, error: `rate-limited after ${SEND_MAX_RETRIES} retries, json=${JSON.stringify(json)}` };
        }
        await sleep(delay);
        delay = Math.min(delay * 2, SEND_RETRY_MAX_DELAY_MS);
        continue;
      }

      // Other error
      return { success: false, error: `ret=${ret} errcode=${errcode} errmsg=${errmsg}` };
    } catch (e: any) {
      if (attempt === SEND_MAX_RETRIES) return { success: false, error: e.message };
      await sleep(delay);
      delay = Math.min(delay * 2, SEND_RETRY_MAX_DELAY_MS);
    }
  }
  return { success: false, error: 'exhausted retries' };
}

// --- Public API ---

export async function sendMessage(
  config: BridgeConfig, to: string, text: string, contextToken?: string,
): Promise<{ success: boolean; error?: string; msgId?: string }> {
  return sendMessageWithRateLimit(config, to, text, contextToken);
}

export async function sendTyping(
  config: BridgeConfig, toUserId: string, typingTicket: string, status: number,
): Promise<void> {
  await apiPost(config, 'ilink/bot/sendtyping', {
    ilink_user_id: toUserId, typing_ticket: typingTicket, status,
  });
}

export async function fetchMessages(
  config: BridgeConfig,
  syncKey: any,
  contextTokenMap: Map<string, string>,
  myUserIdRef: { current: string },
): Promise<{ messages: WeChatMessage[]; newSyncKey: any }> {
  try {
    const syncBuf = typeof syncKey === 'string' ? syncKey : (syncKey?.get_updates_buf || '');
    const json: LongPollResponse = await apiPost(
      config, 'ilink/bot/getupdates', { get_updates_buf: syncBuf }, {}, POLL_TIMEOUT_MS,
    );

    // Session expired or stale session
    if (json.ret === SESSION_EXPIRED_ERRCODE || isStaleSession(json.ret, json.errcode, json.errmsg)) {
      return { messages: [], newSyncKey: syncKey, sessionExpired: true } as any;
    }

    // ret=undefined or ret=0 both mean success
    if (json.ret !== undefined && json.ret !== 0) {
      return { messages: [], newSyncKey: syncKey };
    }

    const messages = parseMessagesFromResponse(json);
    for (const msg of messages) {
      if (msg.contextToken) contextTokenMap.set(msg.fromUserId, msg.contextToken);
    }

    const extractedUserId = tryExtractMyUserId(json);
    if (extractedUserId) myUserIdRef.current = extractedUserId;

    // Update sync buffer
    const newSyncBuf = json.get_updates_buf || syncBuf;
    if (newSyncBuf) saveSyncBuf(newSyncBuf);

    return { messages, newSyncKey: newSyncBuf };
  } catch {
    return { messages: [], newSyncKey: syncKey };
  }
}

/**
 * WeChat long-poll loop with dedup, backoff, and session expiry handling.
 */
export function startMessagePolling(
  config: BridgeConfig,
  onMessages: (messages: WeChatMessage[]) => void,
  onError?: (error: Error) => void,
  onSessionExpired?: () => void,
): { stop: () => void } {
  let running = true;
  let syncKey: any = loadSyncBuf(); // Resume from persisted sync buffer
  const contextTokenMap = new Map<string, string>();
  const myUserIdRef = { current: '' };

  // Message dedup
  const recentMsgIds = new Set<string>();
  let consecutiveFailures = 0;

  // Debug logging to file (console.log is lost when bridge runs detached)
  const LOG_FILE = join(homedir(), '.wechat-claude-skill', 'bridge.log');
  const debugLog = (msg: string) => {
    try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
  };

  (async () => {
    while (running) {
      try {
        debugLog('[POLL] Polling...');
        const result = await fetchMessages(config, syncKey, contextTokenMap, myUserIdRef);
        const { messages, newSyncKey } = result as any;
        if (newSyncKey) syncKey = newSyncKey;
        debugLog(`[POLL] Got ${messages?.length || 0} messages, syncKey=${typeof syncKey === 'string' ? syncKey.slice(0, 20) : 'object'}`);

        // Session expired: pause for 1 hour
        if ((result as any).sessionExpired) {
          if (onSessionExpired) onSessionExpired();
          await sleep(SESSION_EXPIRED_PAUSE_MS);
          consecutiveFailures = 0;
          continue;
        }

        consecutiveFailures = 0;

        // Dedup: skip already-processed messages
        const freshMessages: WeChatMessage[] = [];
        for (const msg of messages) {
          if (recentMsgIds.has(msg.msgId)) continue;
          recentMsgIds.add(msg.msgId);
          freshMessages.push(msg);
        }

        // Evict old IDs
        if (recentMsgIds.size > MAX_RECENT_MSG_IDS) {
          const iter = recentMsgIds.values();
          for (let i = 0; i < MAX_RECENT_MSG_IDS / 2; i++) {
            const { value } = iter.next();
            if (value !== undefined) recentMsgIds.delete(value);
          }
        }

        if (freshMessages.length > 0 && running) {
          onMessages(freshMessages);
        }
      } catch (e: any) {
        consecutiveFailures++;
        if (running && onError) onError(e);
      }

      // Backoff on consecutive failures
      if (running) {
        const backoff = consecutiveFailures >= BACKOFF_THRESHOLD ? BACKOFF_LONG_MS : BACKOFF_SHORT_MS;
        await sleep(backoff);
      }
    }
  })();

  return { stop: () => { running = false; } };
}
