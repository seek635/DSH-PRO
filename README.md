# DSH PRO

> **English**: A browser extension + local bridge that turns the DeepSeek web UI (chat.deepseek.com) into a local-capable agent — file read/write, directory tree, search, sandboxed bash, git queries — with multi-step tasks handed off to DeepSeek Harness (`dsh --profile headless`) for autonomous execution. No public tunnel needed; the bridge listens on 127.0.0.1 only. A community integration for the DeepSeek Harness ecosystem (not a cordis bundle — install via the steps below).

把 **DeepSeek 网页版（chat.deepseek.com）** 升级为可以操作你本地电脑的 Agent：文件读写、目录树、搜索、安全 bash、git 查询，并且能把计划 **handoff 给 DeepSeek Harness（dsh headless）** 真正执行——和 CodexPro 的工作流同构，但执行器换成 dsh，而且**不需要任何公网隧道**（桥接服务只监听本机 127.0.0.1）。

```
chat.deepseek.com
  └─ DSH PRO 扩展（注入页面：面板 UI + 协议循环）
        ↓  http://127.0.0.1:8765  （Bearer token）
     桥接服务 bridge/server.js（纯 Node 内置模块，零依赖）
        ├─ 10 个本地工具（tree/read/write/edit/search/bash/git_status/git_diff/handoff/log）
        └─ handoff：计划落盘 .dsh-pro/ → spawn `dsh --profile headless "…"` → 轮询取结果
```

## 一次性安装（约 5 分钟）

1. **配对**：右键 `scripts\pair.ps1` →「使用 PowerShell 运行」（或终端里 `powershell -ExecutionPolicy Bypass -File "D:\DSH PRO\scripts\pair.ps1"`）。
   它会生成随机 token 写入 `bridge\config.json`，**自动复制到剪贴板**，并启动桥接服务。
2. **装扩展**：Edge 打开 `edge://extensions`（Chrome 是 `chrome://extensions`）→ 开启「开发人员模式」→「加载解压缩的扩展」→ 选择 `D:\DSH PRO\extension`。
3. **配对扩展**：打开 `https://chat.deepseek.com`，右下角出现 **DSH PRO** 面板 → 点「设置」→ 把 token 粘贴进「桥接 Token」→「保存设置」→「连接测试」，圆点变绿即成功。
4. **启用**：点「启用」→ 扩展会自动发出一段协议说明消息（发送前有 2 秒预览可取消）→ DeepSeek 回复"已理解协议"后面板显示**就绪**。

> 建议在**独立会话**中使用（面板里先手动新建一个会话），不污染日常对话。

## 日常使用

1. 双击 `scripts\start-dsh-pro.cmd` 启动桥接（已在运行则跳过）。
2. 在 DeepSeek 里直接下任务，例如：
   - 「列出工作区根目录结构」
   - 「读 harness-desktop/main.js 前 30 行，解释启动流程」
   - 「在 .dsh-pro/notes.md 里记录今天的结论」
3. **两种执行模式**（协议消息里也会写明）：
   - **轻量查看**（1~2 个工具）：直接说「读一下 xxx 的前 30 行」，逐步调用，对话里可见每一步工具调用与结果。
   - **多步任务（推荐）**：「先制定完整计划，然后 handoff 执行」→ DeepSeek 输出计划并只调用一次 `dsh_handoff` → **本地 dsh headless agent 自主闭环执行整个计划**（读文件/搜索/改代码/跑命令），对话全程静默 → 扩展轮询到完成后**一次性回传最终结果** → DeepSeek 向用户总结，对话里只有计划+结果（CodexPro 同款体验）。执行期间面板每 20s 显示进度（耗时 + dsh 实时输出尾部），点「停止」会真正终止本地进程。完成后可再说「验收一下改动」让它跑 `dsh_git_diff` 出审查报告。
4. 收工双击 `scripts\stop-dsh-pro.cmd`（会优雅关闭桥接并清理残留 dsh 进程）。

## 工具清单（10 个）

| 工具 | 说明 | 参数 |
|---|---|---|
| dsh_tree | 目录树（跳过 node_modules/.git） | path?, depth?=3 |
| dsh_read | 读文本文件片段（1-based 行，**带行号输出**，返回 sha256） | path, offset?=1, limit?=200 |
| dsh_write | 写文件（整文件覆盖，自动建父目录） | path, content, expectedSha256? |
| dsh_edit | 唯一匹配精确替换（expectedSha256 可防陈旧内容误改） | path, oldText, newText, expectedSha256? |
| dsh_search | 内容搜索（纯文本或正则） | query, path?, regex?, maxResults?=50 |
| dsh_bash | 安全白名单命令 | command, timeoutMs?=20000 |
| dsh_git_status | git status porcelain | path? |
| dsh_git_diff | git diff（超大自动落盘） | path?, staged?, maxBytes?=48000 |
| dsh_handoff | 计划交给 dsh headless 执行 | planText, workspace?, taskNote? |
| dsh_log | 读执行日志尾部（每次工具调用自动记录） | lines?=100 |

所有路径都是**工作区相对路径**；超 24KB 的结果自动落盘到 `.dsh-pro/outputs/` 并回传文件路径，用 `dsh_read` 分段读。

## 执行日志

每次工具调用（含失败）都会追加一条 JSONL 事件到 `<工作区>/.dsh-pro/logs/execution-log.jsonl`：时间戳、工具名、参数摘要（正文类参数省略）、成败、耗时、错误码。模型侧每个结果都带 `logFile` 路径，可直接 `dsh_log` 或 `dsh_read` 回看"到底对电脑做了什么"；用户侧可直接打开该文件审计。

## 安全模型

- 桥接只绑 `127.0.0.1:8765`，扩展与桥接用 64 位随机 token 配对。
- **工作区白名单**：默认 `D:\DeepSeek Harness`、`D:\HiSpark_Studio`（在 `bridge\config.json` 的 allowedRoots 增删，改后重启桥接）。路径逃逸（`..`）、符号链接穿出、`.git/`、`node_modules/`、密钥/凭据文件（`.env*`、`*.pem`、`*.key`、`*credential*`…）一律拦截。
- **bash 三层过滤**：白名单（dir/type/git status|diff|log/npm test…）→ 黑名单（rm/del/curl/powershell/git push|commit…）→ 元字符封禁（`| & > ; \` $ 换行`）。白名单外、黑名单外的命令会触发**面板确认弹窗**（允许一次/拒绝）；写 `.env*`、`package.json`、锁文件也需确认。
- 循环上限默认 15 轮（可调 5–30）；自动发送 1.5s 节流 + 单日 200 条上限；所有自动发送前有 2 秒预览可取消。
- 审计日志：`bridge\audit.jsonl`；每次 handoff 落盘 `<工作区>\.dsh-pro\`（plans/agent-status.md/execution-log.jsonl/runs/）。

## 已验证（2026-09-13 本机实测）

- 无 token 401 / 带 token 200 且 `dsh.binFound:true`
- 9 个工具全部可用；`rm -rf /`、`git push`、元字符拼接全部拦截；确认令牌闭环通过
- handoff 全链路：计划落盘 → dsh headless 执行（exit 0，15.5s）→ stdout 采集 → `runs/<runId>.json` 持久化，桥接重启后仍可查询
- stop 脚本优雅关闭且无残留 dsh 进程；start 脚本幂等

## 页面改版怎么办

DeepSeek 网页没有公开 DOM 契约，改版可能导致「提取不到回复内容 / 找不到输入框」：

1. 面板「设置」→「自定义选择器」里粘贴 JSON 覆盖内置候选（支持 `input` / `sendButton` / `assistantMarkdown` / `messageContainer` / `stopButton` 五类），保存即生效。例：`{"input":"textarea#chat-input","sendButton":"button[data-testid=send]"}`。
2. 仍不行则改 `extension\selectors.js` 的候选表，然后在扩展管理页点「刷新」。

## 风险与限制（务必阅读）

- **账号风险**：自动填入/发送消息是模拟人工操作，高频使用可能触发 DeepSeek 风控（限流/验证码）甚至违反服务条款。本工具已内置节流与日上限，风险自担。
- **headless 首跑**：dsh headless profile 首次使用会自动初始化，耗时较长；登录态依赖 `~\.dsh\.credentials.yaml`，过期时 handoff 以退出码 1 失败、stderr 原文透传。
- **与 CodexPro 并存**：状态目录（`.dsh-pro` vs `.ai-bridge`）、端口（8765 vs 8787）已隔离，可同时运行；但**同一时间一个工作区只用一套 agent**，避免两套工具同时改文件。
- token 消耗：工具结果会进入 DeepSeek 上下文，读大文件请用 offset/limit 分页。
