/**
 * Setup script for wechat-claude-skill.
 *
 * Usage (after npm install -g):
 *   wechat-claude-skill install      Install skill + hook to global (~/.claude/)
 *   wechat-claude-skill uninstall    Remove skill + hook from global
 *   wechat-claude-skill vscode       VSCode mode: QR login + hook (one-way notify)
 *   wechat-claude-skill cli          CLI mode: QR login + bridge (bidirectional)
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { loadAccount, interactiveLogin, type AccountData } from './auth.js';
import { BRIDGE_DIR } from './config.js';

const BRIDGE_PID_FILE = join(BRIDGE_DIR, 'bridge.pid');
const STATE_FILE = join(BRIDGE_DIR, 'state.json');
const BRIDGE_PORT = 3456;
// Use forward slashes for cross-platform compatibility (exec form args)
const HOOK_HANDLER_PATH = join(import.meta.dirname, 'hook-handler.js').replace(/\\/g, '/');

// Global skill directory for Claude Code
const GLOBAL_SKILL_DIR = join(homedir(), '.claude', 'skills', 'wechat');
const GLOBAL_SKILL_FILE = join(GLOBAL_SKILL_DIR, 'SKILL.md');

interface State {
  mode: 'cli' | 'vscode';
  pid: number;
  startedAt: string;
  sessionId?: string;
  cwd?: string;
}

function saveState(state: State): void {
  mkdirSync(BRIDGE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function loadState(): State | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function isBridgeRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process by PID. Uses taskkill on Windows for reliability. */
function killProcess(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore', timeout: 5000 });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {}
}

/**
 * Check if a port is in use (indicating a bridge is running).
 * More reliable than wmic process matching.
 */
function isPortInUse(port: number): boolean {
  try {
    const output = execSync(
      process.platform === 'win32'
        ? `netstat -ano | findstr :${port} | findstr LISTENING`
        : `lsof -i :${port}`,
      { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Wait for a port to be released (max 5 seconds).
 * Returns true if port is free, false if timeout.
 */
async function waitForPortRelease(port: number, maxWaitMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!isPortInUse(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function stopExistingBridge(): void {
  // 1. Kill by saved PID (fast path)
  const state = loadState();
  let killed = false;
  if (state && isBridgeRunning(state.pid)) {
    console.log(`Stopping existing bridge (PID ${state.pid})...`);
    killProcess(state.pid);
    killed = true;
  }

  // 2. If port is still in use, try to kill any process using it
  if (isPortInUse(BRIDGE_PORT)) {
    console.log(`Port ${BRIDGE_PORT} still in use, forcing cleanup...`);
    try {
      // Find and kill process using the port
      if (process.platform === 'win32') {
        const output = execSync(
          `netstat -ano | findstr :${BRIDGE_PORT} | findstr LISTENING`,
          { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const lines = output.trim().split('\n');
        for (const line of lines) {
          const match = line.trim().match(/(\d+)\s*$/);
          if (match) {
            const pid = parseInt(match[1], 10);
            if (pid && pid !== process.pid) {
              console.log(`Killing process ${pid} using port ${BRIDGE_PORT}`);
              killProcess(pid);
              killed = true;
            }
          }
        }
      }
    } catch {}
  }

  // 3. Wait for port to be released
  if (killed) {
    console.log('Waiting for port to be released...');
    const released = waitForPortRelease(BRIDGE_PORT, 5000);
    if (!released) {
      console.warn('Warning: Port not released, will retry anyway');
    }
  }

  // 4. Clean up state files
  try { unlinkSync(BRIDGE_PID_FILE); } catch {}
  try { unlinkSync(STATE_FILE); } catch {}
}

/**
 * Ensure we have a valid account. Do QR login if needed.
 */
async function ensureAccount(): Promise<AccountData> {
  let account = loadAccount();
  if (account) {
    console.log(`Using existing account: ${account.accountId}`);
    return account;
  }

  console.log('No account found. Starting QR code login...\n');
  account = await interactiveLogin();
  console.log(`\nLogin successful! Account: ${account.accountId}`);
  return account;
}

function getClaudeSettingsPath(): string {
  // Use global settings: ~/.claude/settings.json
  return join(homedir(), '.claude', 'settings.json');
}

/**
 * Remove all hook-handler entries from all hook events in settings.
 * Returns the cleaned settings object.
 */
function removeAllHookHandlerEntries(settings: any): any {
  if (!settings.hooks) return settings;
  for (const eventName of Object.keys(settings.hooks)) {
    const entries = settings.hooks[eventName];
    if (!Array.isArray(entries)) continue;
    // Filter out entries that contain hook-handler in any of their hooks
    settings.hooks[eventName] = entries.filter((entry: any) =>
      !entry.hooks?.some((h: any) =>
        (h.command && h.command.includes('hook-handler')) ||
        (h.args && h.args.some((a: string) => a.includes('hook-handler')))
      )
    );
    if (settings.hooks[eventName].length === 0) delete settings.hooks[eventName];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

function writeHookConfig(): void {
  const settingsPath = getClaudeSettingsPath();
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
  }

  // Remove ALL existing hook-handler entries from ALL events (Stop, Notification, etc.)
  // This cleans up any stale registrations from previous versions
  settings = removeAllHookHandlerEntries(settings);

  // Add the hook to Stop event only, using exec form to avoid shell path issues
  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = settings.hooks.Stop || [];
  settings.hooks.Stop.push({
    hooks: [{
      type: 'command',
      command: 'node',
      args: [HOOK_HANDLER_PATH],
      async: true,
      timeout: 60,
    }],
  });

  const dir = join(settingsPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Hook config written to: ${settingsPath}`);
}

function removeHookConfig(): void {
  const settingsPath = getClaudeSettingsPath();
  if (!existsSync(settingsPath)) return;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    removeAllHookHandlerEntries(settings);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`Hook config removed from: ${settingsPath}`);
  } catch {}
}

/**
 * Spawn bridge as a detached background process.
 * Returns a Promise that resolves when bridge signals BRIDGE_READY (or on timeout).
 * Pipes are destroyed after readiness so the parent process can exit cleanly.
 */
function startBridgeDetached(mode: 'cli' | 'vscode', sessionId?: string): Promise<void> {
  // Use dist/bridge.js (compiled) instead of src/bridge.ts (source)
  const bridgePath = join(import.meta.dirname, '..', 'dist', 'bridge.js');
  const args = [bridgePath, '--mode', mode];
  if (sessionId) args.push('--session', sessionId);
  args.push('--cwd', process.cwd());

  const child = spawn('node', args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  child.unref();

  return new Promise((resolve) => {
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve();
    };

    let output = '';
    child.stdout?.on('data', (data) => {
      output += data.toString();
      const match = output.match(/BRIDGE_READY:(\d+)/);
      if (match && !resolved) {
        const pid = parseInt(match[1], 10);
        saveState({ mode, pid, startedAt: new Date().toISOString(), sessionId, cwd: process.cwd() });
        console.log(`Bridge started (PID ${pid})`);
        finish();
      }
    });

    child.stderr?.on('data', (data) => {
      console.error(`Bridge error: ${data.toString()}`);
    });

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Bridge exited with code ${code}`);
      }
      finish();
    });

    // Safety timeout: if bridge doesn't signal ready within 15s, exit anyway
    setTimeout(() => {
      if (!resolved) {
        console.error('Bridge failed to start within 15 seconds');
        finish();
      }
    }, 15000);
  });
}

// Run bridge directly in current process (for CLI mode)
async function runBridgeDirectly(mode: 'cli' | 'vscode', sessionId?: string): Promise<void> {
  // Set command line arguments for bridge
  process.argv = ['node', 'bridge.js', '--mode', mode];
  if (sessionId) process.argv.push('--session', sessionId);
  process.argv.push('--cwd', process.cwd());

  // Import and run bridge (use compiled dist/bridge.js)
  const bridgePath = join(import.meta.dirname, '..', 'dist', 'bridge.js');
  const bridgeUrl = `file:///${bridgePath.replace(/\\/g, '/')}`;
  await import(bridgeUrl);
}

/**
 * Wait for the bridge to receive the first user message (Bot activation).
 * Polls the /health endpoint until `activated` is true or timeout.
 * Returns true if activated, false if timeout.
 */
async function waitForActivation(timeoutMs = 60_000): Promise<boolean> {
  console.log('⏳ 等待微信激活（请给 Bot 发一条消息，任意内容即可）...');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`);
      const data = await res.json() as any;
      if (data.activated) {
        console.log('✅ Bot 已激活！微信消息通道已就绪\n');
        return true;
      }
    } catch {
      // Bridge not ready yet, retry
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('⚠️  等待超时（60秒），Bot 可能未激活。');
  console.log('   请确保已在微信中给 Bot 发送了一条消息。\n');
  return false;
}

// --- CLI mode ---
async function setupCli(): Promise<void> {
  console.log('Starting WeChat binding (CLI mode)...\n');

  // Session ID can come from:
  // 1. CLI argument: wechat-claude-skill cli <sessionId>
  // 2. Environment variable: $CLAUDE_CODE_SESSION_ID (set by Claude Code)
  let sessionId = process.argv[3] || process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    console.log('⚠️  No session ID provided.');
    console.log('   CLI bidirectional mode requires a session ID.');
    console.log('   Usage: wechat-claude-skill cli <sessionId>');
    console.log('   Or run from Claude Code skill (auto-provides $CLAUDE_CODE_SESSION_ID)');
    console.log('');
    console.log('   Aborting (use /wechat vscode for VSCode mode)\n');
    process.exit(1);
  }

  // Only stop existing bridge if we have a valid session (going to run CLI mode)
  stopExistingBridge();
  await ensureAccount();  // Auto-login if needed

  writeHookConfig();

  // Start bridge in a NEW terminal window (so PTY output is visible)
  // This opens a new CMD window where the Claude Code session will run
  console.log('📱 正在打开新终端窗口...');
  await startBridgeInNewTerminal('cli', sessionId);

  console.log('✅ 微信双向绑定已启动');
  console.log('   📺 新终端窗口已打开，Claude Code 将在该窗口中运行');
  console.log('   📱 微信发消息 → 自动注入到 Claude');
  console.log('   💬 Claude 回复 → 自动推送到微信');
  console.log('\n💡 使用方式：');
  console.log('   1. 在新打开的终端窗口中与 Claude 对话');
  console.log('   2. 同时可以在微信中发送消息，会自动注入到该终端');
  console.log('   3. 按 Ctrl+C 退出');
}

/**
 * Start bridge in a new terminal window (visible PTY).
 * This opens a CMD window where the PTY runs, so user can see Claude Code.
 */
async function startBridgeInNewTerminal(mode: 'cli' | 'vscode', sessionId?: string): Promise<void> {
  const bridgePath = join(import.meta.dirname, '..', 'dist', 'bridge.js');
  const args = [bridgePath, '--mode', mode];
  if (sessionId) args.push('--session', sessionId);
  args.push('--cwd', process.cwd());

  // Use start command to open new CMD window, then run node in that window
  // /K keeps the window open after command completes
  const cmd = `start "Claude Code - WeChat Bridge" cmd /K node ${args.map(a => `"${a}"`).join(' ')}`;

  spawn('cmd', ['/c', cmd], {
    detached: true,
    stdio: 'ignore',
    shell: false,
  }).unref();

  // Wait a bit for the new window to open
  await new Promise(r => setTimeout(r, 1000));
}

// --- VSCode mode ---
async function setupVscode(): Promise<void> {
  console.log('Setting up WeChat binding (VSCode mode)...\n');

  stopExistingBridge();  // Clean up any existing bridge
  await ensureAccount();  // Auto-login if needed (QR code shown inline)
  writeHookConfig();  // Write hook config

  // Start bridge in background to maintain getUpdates long-polling connection.
  // Without this, iLink accepts sendMessage but never delivers to WeChat.
  // Await BRIDGE_READY so the parent process doesn't exit before bridge is up.
  await startBridgeDetached('vscode');

  // Wait for Bot activation (first user message received)
  await waitForActivation(60000);

  console.log('✅ 微信通知已启动 (VSCode 模式)');
  console.log('   Claude 回复将自动推送到微信（单向通知）');
}

// --- Install: Install skill + hook to global ---
async function installSkill(): Promise<void> {
  console.log('Installing wechat-claude-skill...\n');

  // Check if running from a persistent location (global install) or temporary (npx)
  const isNpxTemp = import.meta.dirname.includes('_npx') || 
                    import.meta.dirname.includes('npm-cache') ||
                    import.meta.dirname.includes('Temp') ||
                    import.meta.dirname.includes('tmp');

  if (isNpxTemp) {
    console.log('⚠️  WARNING: Running from temporary npx cache!');
    console.log('   The hook path will be invalid after npx cache cleanup.');
    console.log('   Please install globally instead:');
    console.log('');
    console.log('   npm install -g wechat-claude-skill');
    console.log('   wechat-claude-skill install');
    console.log('');
    process.exit(1);
  }

  // 1. QR login (one-time setup, interactive)
  await ensureAccount();

  // 2. Write hook config to global settings
  writeHookConfig();

  // Generate and write SKILL.md to global skills directory
  const skillContent = `---
name: wechat
description: Sync Claude Code conversations to WeChat. Use when user runs /wechat to enable WeChat notifications or bidirectional communication.
---

# WeChat Integration for Claude Code

When the user runs \`/wechat\`, do the following:

1. Ask the user to select their environment:
   - "1. CLI 终端（双向通信：可从微信回复）"
   - "2. VSCode（单向通知：仅推送 Claude 回复）"

2. Based on their choice, run the appropriate command:

   **For CLI terminal:**
   \`\`\`bash
   wechat-claude-skill cli "$CLAUDE_CODE_SESSION_ID"
   \`\`\`

   **For VSCode:**
   \`\`\`bash
   wechat-claude-skill vscode
   \`\`\`

3. After running the command:
   - For CLI: Tell the user:
     "✅ 微信双向绑定已启动！已自动打开新终端窗口，Claude Code 将在该窗口中运行。
     你可以：
     - 在新终端窗口中与 Claude 对话
     - 同时在微信中发消息，会自动注入到 Claude
     当前会话可以退出（输入 /exit 或 Ctrl+C）"
   - For VSCode: Tell the user:
     "✅ 微信通知已绑定成功！请立即在微信中给你刚绑定的 Bot 发一条消息（任意内容），这是激活 Bot 的必要步骤。之后 Claude 的回复就会自动推送到微信了。"
   - **IMPORTANT**: Always remind the user to send a message to the Bot first — the Bot won't work until activated by a user message.

## Unbind

Run \`/unwechat\` or \`wechat-claude-skill unbind\`
`;

  mkdirSync(GLOBAL_SKILL_DIR, { recursive: true });
  writeFileSync(GLOBAL_SKILL_FILE, skillContent);
  console.log(`Skill installed to: ${GLOBAL_SKILL_FILE}`);

  // 3. Also write unwechat skill
  const unwechatContent = `---
name: unwechat
description: Unbind WeChat from Claude Code. Use when user runs /unwechat to disable WeChat notifications.
---

# Unbind WeChat

When the user runs \`/unwechat\`, run:

\`\`\`bash
wechat-claude-skill unbind
\`\`\`

Tell the user WeChat has been unbound (skill still installed, use /wechat to re-bind).
`;

  const unwechatDir = join(homedir(), '.claude', 'skills', 'unwechat');
  mkdirSync(unwechatDir, { recursive: true });
  writeFileSync(join(unwechatDir, 'SKILL.md'), unwechatContent);
  console.log(`Skill installed to: ${join(unwechatDir, 'SKILL.md')}`);

  console.log('\n✅ Installation complete!');
  console.log('   Run /wechat in Claude Code to start binding.');
}

// --- Unbind: Stop bridge + remove hook + delete account (keep skill files) ---
function unbindWeChat(): void {
  console.log('Unbinding WeChat...\n');

  // 1. Stop bridge
  stopExistingBridge();

  // 2. Remove hook config
  removeHookConfig();

  // 3. Delete account.json (user will need to re-scan QR next time)
  const accountPath = join(BRIDGE_DIR, 'account.json');
  if (existsSync(accountPath)) {
    unlinkSync(accountPath);
    console.log('Account data deleted');
  }

  console.log('✅ WeChat unbound! (Skill still installed, use /wechat to re-bind)');
}

// --- Uninstall: Remove everything including skill files ---
function uninstallSkill(): void {
  console.log('Uninstalling wechat-claude-skill...\n');

  // 1. Stop bridge and remove hook config
  stopExistingBridge();
  removeHookConfig();

  // 2. Remove global skill files
  try { unlinkSync(GLOBAL_SKILL_FILE); } catch {}
  try { unlinkSync(join(homedir(), '.claude', 'skills', 'unwechat', 'SKILL.md')); } catch {}

  // 3. Remove empty skill directories
  try { rmdirSync(GLOBAL_SKILL_DIR); } catch {}
  try { rmdirSync(join(homedir(), '.claude', 'skills', 'unwechat')); } catch {}

  // 4. Delete account.json
  const accountPath = join(BRIDGE_DIR, 'account.json');
  if (existsSync(accountPath)) {
    unlinkSync(accountPath);
    console.log('Account data deleted');
  }

  console.log('✅ Uninstallation complete!');
}

// --- Main ---
// Clean up stale bridge processes on every invocation
// (e.g. if bridge died without cleaning up state.json)
const staleState = loadState();
if (staleState && isBridgeRunning(staleState.pid)) {
  // A previous bridge is still running — check if port is actually in use
  if (!isPortInUse(BRIDGE_PORT)) {
    // PID is alive but not listening on our port — stale state file
    try { unlinkSync(STATE_FILE); } catch {}
    try { unlinkSync(BRIDGE_PID_FILE); } catch {}
  }
}

const action = process.argv[2];
switch (action) {
  case 'install':
    installSkill().catch((e) => { console.error('Install failed:', e.message); process.exit(1); });
    break;
  case 'uninstall':
    uninstallSkill();
    break;
  case 'cli':
    setupCli().catch((e) => { console.error('Setup failed:', e.message); process.exit(1); });
    break;
  case 'vscode':
    setupVscode().catch((e) => { console.error('Setup failed:', e.message); process.exit(1); });
    break;
  case 'unbind':
    unbindWeChat();
    break;
  case 'uninstall':
    uninstallSkill();
    break;
  default:
    console.log('wechat-claude-skill - Claude Code WeChat Integration\n');
    console.log('Usage:');
    console.log('  wechat-claude-skill install      Install skill + hook to global');
    console.log('  wechat-claude-skill unbind       Unbind WeChat (keep skill, can re-bind)');
    console.log('  wechat-claude-skill uninstall    Completely remove skill + hook');
    console.log('  wechat-claude-skill vscode       Start VSCode mode (one-way notify)');
    console.log('  wechat-claude-skill cli [sid]    Start CLI mode (bidirectional)');
    process.exit(1);
}
