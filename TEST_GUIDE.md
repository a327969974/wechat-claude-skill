# CLI + 微信双通道优化 - 自测验证指南

## 测试环境准备

### 1. 确保 Bot 已激活
- 微信中已给 Bot 发过至少一条消息
- bridge 可以正常运行

### 2. 清理旧状态
```bash
# 停止现有 bridge 进程（如有）
taskkill /F /IM node.exe 2>nul
rm -f ~/.wechat-claude-skill/state.json
```

---

## 测试用例

### 测试 1：输入锁功能（核心）
**目标**：验证 Claude 忙碌时微信消息只显示不注入

**步骤**：
1. 启动 CLI 模式：`npx tsx src/setup.ts cli`
2. 在 CLI 终端让 Claude 执行一个耗时任务，例如：
   ```
   写一个计算斐波那契数列的函数，执行递归计算 fib(30)
   ```
3. 在 Claude 正在生成回复的过程中，从微信发送消息：「测试输入锁」
4. 观察 CLI 终端：
   - ✅ **预期**：终端显示 `[微信 HH:MM:SS] 你的微信名: 测试输入锁`（青色+黄色）
   - ✅ **预期**：这条消息**不会**立即被注入 Claude 的输入中
   - ✅ **预期**：Claude 完成回复后，微信消息才被注入处理

**失败标志**：
- ❌ 微信消息在 Claude 输出中间被注入，导致输出乱序
- ❌ 终端没有显示带颜色的通知

---

### 测试 2：消息时间排序
**目标**：多条微信消息按时间顺序注入

**步骤**：
1. 连续快速发送 3 条微信消息（间隔约 1 秒）：
   - 第 1 条：「消息 A」
   - 第 2 条：「消息 B」
   - 第 3 条：「消息 C」
2. 观察 Claude 收到的输入顺序

**预期**：Claude 按 A → B → C 顺序收到消息

---

### 测试 3：CLI 模式 hook 不重复发送
**目标**：验证 CLI 模式下 Claude 回复只发送一次到微信

**步骤**：
1. 启动 CLI 模式
2. 让 Claude 生成一条回复
3. 检查微信只收到 **1 条** 回复

**预期**：微信只收到 1 条 Claude 的回复（不是 2 条）

---

### 测试 4：VSCode 模式仍然正常
**目标**：确认 VSCode 模式不受影响

**步骤**：
1. 停止 CLI 模式
2. 启动 VSCode 模式：`npx tsx src/setup.ts vscode`
3. 让 Claude 生成回复
4. 检查微信收到通知

**预期**：VSCode 模式下 Claude 回复正常推送到微信

---

### 测试 5：hook-handler CLI 模式检测
**目标**：验证 hook-handler 检测到 CLI 模式后正确退出

**步骤**：
1. CLI 模式下触发 Stop hook
2. 检查 `~/.wechat-claude-skill/hook-handler.log`

**预期**：日志显示 `CLI mode active, skipping hook` 并正常退出

---

## 快速验证命令

```bash
cd C:\Users\1\Desktop\开源项目\wechat-claude-skill

# 编译
npx tsc

# 启动 CLI 模式（终端 1）
npx tsx src/setup.ts cli

# 停止所有 node 进程（测试前清理）
taskkill /F /IM node.exe
```

---

## 预期终端输出示例

### 微信消息到达时（Claude 忙碌）
```
[微信 14:30:25] 张三: 测试输入锁
```
（青色 `[微信 14:30:25]`，黄色 `张三`，白色 `: 测试输入锁`）

### 微信消息注入时（Claude 空闲）
```
[14:30:30] [PTY] Injecting WeChat message from 张三: [微信消息 14:30:25 from 张三]：测试输入锁
```