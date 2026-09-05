# ADR-0034：固定 Loopback Endpoint 与持久 Browser Authorization

- **Status:** Accepted
- **Date:** 2026-09-04

## Context

ADR-0004 使用“每次 monitor 进程启动生成随机一次性 URL token，首次访问后换成仅对该进程有效的随机 Cookie”。该方案对本地浏览器攻击面较保守，但产生了明显的产品问题：

- 每次 server restart 都生成新的 `/?token=...` 地址；
- 用户无法把 `http://127.0.0.1:47832/` 当作稳定书签；
- 如果终端不能直接点击长 query URL，只能依赖启动时自动打开浏览器；
- 当前 server 在首选端口被占用时继续尝试后续端口，进一步破坏稳定入口；
- Phase 28 正在把应用升级成长期 Managed Install，浏览器入口也应成为稳定产品契约。

与此同时，Request Content、Input Context、Context Delta、工程路径和 Alerts operational state 均不应因为“只监听 localhost”而变成匿名资源。固定 URL 不能等同于取消认证。

## Decision

### 1. 精确固定 loopback endpoint

- 默认只监听 `127.0.0.1:47832`。
- `CODEX_MONITOR_PORT` 可以显式选择另一个端口，但该值是本次启动的**精确端口**。
- 端口已占用时 fail fast，返回明确 `port_in_use/EADDRINUSE`；不自动尝试 `port + 1`。
- 用户可见访问地址始终是 `http://127.0.0.1:<port>/`，不含 bearer credential。

### 2. 持久本机 auth secret

- Phase 28 Runtime Layout 的 private mutable state 保存一个 32-byte cryptographic random browser-auth secret。
- Development 使用 ignored repo runtime state；Managed Install 使用 `%LOCALAPPDATA%\CodexUsageMonitor\state`。
- secret 不进入 Git、SQLite、日志、Release artifact，不复用 Codex access token/account id。
- secret 缺失时 exclusive-create；格式损坏时 fail closed，不静默轮换导致无法审计的授权变化。

### 3. `open` challenge/proof bootstrap

新增：

```text
codex-usage-monitor open
```

server 只允许两个匿名 auth route：challenge 与 bootstrap。CLI 从正在监听的 server 获取 60 秒短时 one-shot challenge，使用本机 secret 对 `protocol/origin/challenge/expiry` 做 HMAC-SHA256，并只把 proof 交给本机浏览器启动参数。server 验证并消费 challenge 后签发 browser cookie，再立即 `302 /`。

普通 `start` 输出不显示 challenge/proof；默认自动打开浏览器时内部复用同一 bootstrap 流程。`--no-open` 只关闭自动拉起浏览器。

### 4. 跨进程重启的持久 HttpOnly Cookie

- browser cookie 使用 auth secret 签名，绑定 origin，并包含有限过期时间和随机 nonce。
- Cookie 为 `HttpOnly; SameSite=Strict; Path=/`，V1 目标有效期 180 天。
- monitor 进程重启不会自动使 Cookie 失效，因此已授权浏览器可直接点击固定根 URL。
- Cookie 被清除/过期时，用户执行 `codex-usage-monitor open` 重新授权，无需重启 server。
- MAC 校验必须 constant-time；过期、origin mismatch、格式损坏均 fail closed。

### 5. 原有浏览器安全门继续成立

- 仅 IPv4 loopback，不绑定 `0.0.0.0`/LAN；
- Host 只接受当前 exact port 的 `127.0.0.1` 或 `localhost`；
- 有 Origin 时严格同源；
- 不启用 CORS；
- CSP、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy: no-referrer` 保留；
- 除 challenge/bootstrap 外，静态应用和所有 API 都要求有效 browser cookie；
- Alerts POST 继续同时经过 Cookie + Host + Origin allowlist；
- 客户端仍不能提交文件路径或绕过 server-side source locator。

## Alternatives considered

- **固定 47832 并完全取消认证：** 拒绝。浏览器同源策略不能替代本机多用户/本地进程隔离，且敏感 read path 不应匿名开放。
- **继续每进程随机 launch token：** 拒绝。无法满足稳定 URL、书签和跨进程重启访问需求。
- **长期固定 token 放进 URL：** 拒绝。URL bearer credential 容易进入终端历史、截图、复制记录和浏览器历史。
- **长期固定 API key 要求用户手工输入：** 拒绝。增加用户密钥管理成本，且没有优于本机 challenge/proof bootstrap 的价值。
- **自动寻找 47833/47834 等空闲端口：** 拒绝。会导致 bookmark、CLI diagnostics 和后续 local integration 地址漂移。
- **HTTPS + 自签本地证书：** V1.2.0 拒绝。需要证书信任/轮换和浏览器 UX，超出当前纯 loopback 单用户工具范围；如果未来开放 LAN/remote access，必须重新设计 TLS/Auth，而不能沿用本 ADR。

## Consequences

- 用户正常情况下只需记住 `http://127.0.0.1:47832/`。
- 终端不再显示 `?token=<random>`，默认自动浏览器打开也不再是唯一可用入口。
- `startApplication()`、CLI、runtime layout 和 security tests 需要新增 browser-auth seam，并删除每进程 launchToken/sessionSecret 所有权。
- 端口冲突从“静默漂移”变成明确启动错误，运维行为更可预测。
- Browser Cookie 成为较长期 bearer credential，因此 auth secret 文件和 HMAC/expiry/origin 校验成为新的安全关键路径，必须有独立回归测试。
- 本 ADR 完整替代 ADR-0004；ADR-0004 中保留的 loopback/Host/Origin/CSP/no-CORS/ID-validation 目标在本 ADR 中重新确认。
