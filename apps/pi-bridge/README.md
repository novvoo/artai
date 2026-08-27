# pi-bridge — artai × pi-coding-agent 本地协议桥

`@earendil-works/pi-coding-agent` 是 Node 侧的终端编码代理框架（终端 SDK，
无法在浏览器标签页中运行）。本目录把它接入 artai Studio：一个本地 HTTP 服务，
把 Studio 发出的 **OpenAI `/v1/chat/completions` 线协议**翻译为
**pi SDK 会话调用**。artai 库与 Studio 无需任何协议改动 ——
`parse / designMotif / composeGraph / refinePrompt` 四项 LLM 能力全部经 pi 路由。

## 启动

```bash
npm install                 # @earendil-works/pi-coding-agent 已是 workspace 依赖
npm run dev                 # 推荐：pi-bridge 随 Studio 一并启动（8787）
npm run bridge              # 或只启动 bridge
PI_BRIDGE_PORT=9000 npm run bridge   # 自定义端口
```

`npm run dev` 会先做 health 检测 —— 端口上已有 bridge 在跑就跳过，
不会 EADDRINUSE；Ctrl+C 一并退出两个进程。

## 认证（任选其一）

| 方式 | 做法 |
|------|------|
| pi 订阅复用 | 安装 CLI 后运行 `pi /login`（Claude Pro/Max、ChatGPT Plus/Pro、Copilot 均可） |
| API key | `ANTHROPIC_API_KEY=… npm run bridge`（各 provider 的标准环境变量名都认） |
| 自定义网关 | 编辑 `~/.pi/agent/models.json` 注册自定义 provider（见 pi 文档 docs/custom-provider.md） |

密钥只存在于本机 pi 目录；浏览器永远接触不到。

## Studio 配置

模型设置里选 **pi-node** 预设：

- BASE URL：`http://127.0.0.1:8787/v1`
- MODEL ID：`<providerId>/<modelId>`，例如 `anthropic/claude-sonnet-4-5`、
  `zai/glm-5.3`、`openai/gpt-4o`；支持 thinking 后缀 `anthropic/claude-opus-4-5:high`
- API KEY：留空（认证在本机 pi 手里）
- 点「测试连接」→ 走 parse → 显示 ✓ ok 即接通

可用模型一览：`curl http://127.0.0.1:8787/health` 或在 pi 里 `/model` 查看。

## 工作方式

```
Studio (browser)
   │  POST /v1/chat/completions        ← OpenAI wire（artai BrowserIntentProvider 原生格式）
   ▼
pi-bridge (127.0.0.1)                  ← 本文件：线协议 ↔ 会话调用互转
   │  createAgentSession({ model, noTools:"all",
   │     sessionManager: SessionManager.inMemory() })
   ▼
pi ModelRuntime → provider 目录（39 家）/ auth.json / env keys → 上游 LLM
```

每次请求即用即弃（in-memory session、零工具 allowlist），模型按请求解析。
错误全程结构化透传：目录未知的模型 → 400 invalid_request_error；
凭据缺失 → pi 原生指引文本；空回复 → 502 bridge_empty_reply 带 stopReason。

## 测试

```bash
node --test apps/pi-bridge/     # mock runtime，不需要任何凭据
```
