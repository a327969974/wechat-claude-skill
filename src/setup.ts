/**
 * Setup script for wechat-claude-skill.
 *
 * Usage:
 *   npx wechat-claude-skill install    - Install skill + hook to global (~/.claude/)
 *   npx wechat-claude-skill uninstall  - Remove skill + hook from global
 *   npx wechat-claude-skill vscode     - VSCode mode: QR login + hook (one-way notify)
 *   npx wechat-claude-skill cli        - CLI mode: QR login + bridge (bidirectional)
 *   npx wechat-claude-skill unbind     - Stop bridge + clean up (legacy, use uninstall)
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { loadAccount, interactiveLogin, type AccountData } from './auth.js';
import { BRIDGE_DIR } from './config.js';

const BRIDGE_PID_FILE = join(BRIDGE_DIR, 'bridge.pid');
const STATE_FILE = join(BRIDGE_DIR, 'state.json');
// Use forward slashes for cross-platform compatibility (exec form args)
const HOOK_HANDLER_PATH = join(import.meta.dirname, 'hook-handler.js').replace(/\\/g, '/');
const SETUP_PATH = join(import.meta.dirname, 'setup.js').replace(/\\/g, '/');

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

function stopExistingBridge(): void {
  // Kill by saved PID first
  const state = loadState();
  if (state && isBridgeRunning(state.pid)) {
    console.log(`Stopping existing bridge (PID ${state.pid})...`);
    try { process.kill(state.pid, 'SIGTERM'); } catch {}
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (!isBridgeRunning(state.pid)) break;
    }
  }

  // Also kill any process listening on port 3456
  try {
    const result = execSync('powershell -Command "Get-NetTCPConnection -LocalPort 3456 -ErrorAction SilentlyContinue | Select-Object OwningProcess"', { encoding: 'utf-8' });
    const pids = result.split('\n').map((s: string) => parseInt(s.trim())).filter((p: number) => p > 0 && p !== process.pid);
    for (const pid of pids) {
      console.log(`Killing process on port 3456 (PID ${pid})...`);
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  } catch {}

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

function startBridgeDetached(mode: 'cli' | 'vscode', sessionId?: string): void {
  const bridgePath = join(import.meta.dirname, 'bridge.js');
  const args = [bridgePath, '--mode', mode];
  if (sessionId) args.push('--session', sessionId);
  args.push('--cwd', process.cwd());

  const child = spawn('node', args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  child.unref();

  let output = '';
  child.stdout?.on('data', (data) => {
    output += data.toString();
    const match = output.match(/BRIDGE_READY:(\d+)/);
    if (match) {
      const pid = parseInt(match[1], 10);
      saveState({ mode, pid, startedAt: new Date().toISOString(), sessionId, cwd: process.cwd() });
      console.log(`Bridge started (PID ${pid})`);
    }
  });

  child.stderr?.on('data', (data) => {
    console.error(`Bridge error: ${data.toString()}`);
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Bridge exited with code ${code}`);
    }
  });
}

// Run bridge directly in current process (for CLI mode)
async function runBridgeDirectly(mode: 'cli' | 'vscode', sessionId?: string): Promise<void> {
  // Set command line arguments for bridge
  process.argv = ['node', 'bridge.js', '--mode', mode];
  if (sessionId) process.argv.push('--session', sessionId);
  process.argv.push('--cwd', process.cwd());

  // Import and run bridge (use file:// URL for Windows)
  const bridgePath = join(import.meta.dirname, 'bridge.js');
  const bridgeUrl = `file:///${bridgePath.replace(/\\/g, '/')}`;
  await import(bridgeUrl);
}

// --- CLI mode ---
async function setupCli(): Promise<void> {
  console.log('Starting WeChat binding (CLI mode)...\n');

  stopExistingBridge();
  await ensureAccount();

  const sessionId = process.argv[3];
  writeHookConfig();

  console.log('\n✅ 微信双向绑定已启动 (CLI 模式)');
  console.log('   Claude 回复 → 微信：自动推送');
  console.log('   微信回复 → Claude：PTY 注入（真实用户消息）');
  console.log('   按 Ctrl+C 退出\n');

  // Run bridge directly (blocking, user interacts in terminal)
  await runBridgeDirectly('cli', sessionId);
}

// --- VSCode mode ---
async function setupVscode(): Promise<void> {
  console.log('Setting up WeChat binding (VSCode mode)...\n');

  stopExistingBridge();  // Clean up any existing bridge
  await ensureAccount();  // Check/create account
  writeHookConfig();  // Write hook config

  console.log('\n✅ 微信通知已启动 (VSCode 模式)');
  console.log('   Claude 回复将自动推送到微信（单向通知）');
  console.log('   如需双向通信，请使用 CLI 模式');
}

// --- Unbind ---
function unbind(): void {
  console.log('Unbinding WeChat...');
  stopExistingBridge();
  removeHookConfig();

  // Delete account.json
  const accountPath = join(BRIDGE_DIR, 'account.json');
  if (existsSync(accountPath)) {
    unlinkSync(accountPath);
    console.log('Account data deleted');
  }

  console.log('✅ 微信已解绑');
}

// --- Install: Install skill + hook to global ---
function installSkill(): void {
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

  // 1. Write hook config to global settings
  writeHookConfig();

  // 2. Generate and write SKILL.md to global skills directory
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
   wechat-claude-skill cli
   \`\`\`

   **For VSCode:**
   \`\`\`bash
   wechat-claude-skill vscode
   \`\`\`

3. After running the command:
   - For CLI: Tell the user "微信双向绑定已启动，Claude Code 将自动重启.." then EXIT this session
   - For VSCode: Tell the user the binding is complete. Claude replies will be pushed to WeChat automatically.

## Features

- **VSCode 模式**: Stop hook → 微信单向通知
- **CLI 模式**: Stop hook → 微信通知 + PTY 注入双向通信
- 使用 iLink Bot API，无需登录微信

## Uninstall

Run \`/unwechat\` or \`wechat-claude-skill uninstall\`
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
wechat-claude-skill uninstall
\`\`\`

Tell the user WeChat has been unbound.
`;

  const unwechatDir = join(homedir(), '.claude', 'skills', 'unwechat');
  mkdirSync(unwechatDir, { recursive: true });
  writeFileSync(join(unwechatDir, 'SKILL.md'), unwechatContent);
  console.log(`Skill installed to: ${join(unwechatDir, 'SKILL.md')}`);

  console.log('\n✅ Installation complete!');
  console.log('   Run /wechat in Claude Code to start binding.');
}

// --- Uninstall: Remove skill + hook from global ---
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
const action = process.argv[2];
switch (action) {
  case 'install':
    installSkill();
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
  case 'unbind':  // Legacy, use uninstall
    uninstallSkill();
    break;
  default:
    console.log('wechat-claude-skill - Claude Code WeChat Integration\n');
    console.log('Usage:');
    console.log('  npx wechat-claude-skill install    Install skill + hook to global');
    console.log('  npx wechat-claude-skill uninstall  Remove skill + hook');
    console.log('  npx wechat-claude-skill vscode     Start VSCode mode (one-way notify)');
    console.log('  npx wechat-claude-skill cli        Start CLI mode (bidirectional)');
    process.exit(1);
}
