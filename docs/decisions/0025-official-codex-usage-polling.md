# ADR-0025：账号额度改为轮询 Codex 官方 Usage

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

历史实现从各 rollout 的 `rate_limits` 事件恢复账号额度。这个来源适合审计“某次 Codex 请求当时看到的额度”，但它不是主动查询：如果用户一段时间没有产生新的模型请求，本机 rollout 就不会出现新的额度快照，手动刷新也只能重新扫描旧文件。

当前 Codex 官方 backend client 已提供独立的 rate-limit status GET。ChatGPT backend 使用 `/backend-api/wham/usage`，Codex API path style 使用 `/api/codex/usage`；请求沿用当前 Codex ChatGPT 登录的 Bearer token 和 `ChatGPT-Account-Id`。官方客户端还会把 `chatgpt.com` / `chat.openai.com` 基址规范化到 `/backend-api`。

产品要求额度卡能够在没有新模型请求时自行更新，并默认每分钟刷新一次。

## Decision

- Task / Token / Cost 的事实源继续完全保持本地 Request Ledger，不新增任何远端补算路径。
- 账号额度成为唯一允许的只读网络数据源。监控器从当前 `CODEX_MONITOR_HOME`（默认当前 Windows 用户 `%USERPROFILE%\.codex`）读取 `config.toml` 和 `auth.json`，但绝不修改它们。
- 每次额度请求都重新读取配置和认证文件，以便 Codex 自身刷新 token、切换账号或更新 `chatgpt_base_url` 后监控器无需重启即可跟随。
- 默认 `chatgpt_base_url` 为 `https://chatgpt.com/backend-api`。URL routing 与当前官方 backend-client 一致：含 `/backend-api` 使用 `/wham/usage`，其他基址使用 `/api/codex/usage`。
- 请求只发送 `GET`，携带当前 ChatGPT Bearer token、`ChatGPT-Account-Id`、`Accept: application/json` 和 Codex user-agent。凭据、account id 和原始响应体不得写入监控数据库、日志或前端。
- HTTP transport 优先遵循 `HTTPS_PROXY/ALL_PROXY`；Windows 未配置这些环境变量时只读当前用户 WinINET `ProxyEnable/ProxyServer`，通过 HTTPS CONNECT 使用系统代理。代理设置同样不写入监控数据库。
- 服务启动时查询一次，之后以 60 秒固定周期查询；额度卡手动刷新复用同一个 in-flight 请求，禁止并发重复查询。
- SQLite 只持久化规范化后的账号额度窗口、plan、credits、observedAt 和 `source=official-usage-api`。旧 rollout quota 仍可由 parser 识别用于兼容/审计，但不再进入 current quota，也不再由 session persistence 写入新的账号额度快照。
- 网络失败或后台暂时不可用不会阻止 session/token 监控；保留最后一次已成功的官方额度。显式手动刷新失败返回受控错误。缺少 file-backed ChatGPT auth 时后台静默保留 last-known state，手动刷新明确报告不可用。

## Alternatives considered

- **继续重新扫描 rollout：** 拒绝。没有新 Codex 请求时不会产生新 `rate_limits`，无法满足主动刷新语义。
- **启动/resume Codex App Server 获取额度：** 拒绝。会扩大监控器对 Codex 会话运行时的职责，并破坏既有旁路 observer 边界。
- **调用模型制造一条新请求来逼出额度：** 拒绝。会产生真实用量和副作用。
- **自行刷新 OAuth token 并写回 `auth.json`：** 拒绝。认证生命周期继续由 Codex 管理；监控器只消费 Codex 已经维护的当前凭据。

## Consequences

- 额度卡不再依赖用户先发起一次模型请求，通常可在一分钟内获得新的服务端额度状态。
- 监控器不再是“完全不联网”的进程；网络范围被严格限制为账号额度 GET，Request Ledger、Timeline、USD 等值估算仍然是本地派生。
- 当前实现依赖可读取的 `auth.json` ChatGPT token/account id。若用户把 Codex 凭据放在监控器无法读取的系统 credential store，额度查询会显式不可用，而不会尝试绕过 Codex 的认证存储策略。
- 官方 Usage endpoint 属于 Codex 产品接口而非本项目控制的稳定 API；升级 Codex 时应重新核对路径、认证 header 和 payload fixture。

## Official evidence

- [Codex backend client `rate_limit_status_url`](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)：`ChatGptApi -> /wham/usage`, `CodexApi -> /api/codex/usage`。
- [Codex backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs) 会把 `chatgpt.com` / `chat.openai.com` 基址补齐 `/backend-api`，并在 authenticated request 中发送 `ChatGPT-Account-Id`。
- [App Server rate-limit fixture](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/rate_limits.rs) 的响应包含 `plan_type`、`rate_limit.primary_window/secondary_window`、`used_percent`、`limit_window_seconds` 和 `reset_at`。
