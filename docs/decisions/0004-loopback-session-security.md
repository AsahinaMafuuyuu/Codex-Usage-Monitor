# ADR-0004：采用 loopback 和启动会话安全边界

- **Status:** Superseded by ADR-0034
- **Date:** 2026-08-24

## Context

即使服务只在本机运行，任意网页仍可能尝试访问 localhost、探测接口或诱导浏览器发送请求。页面返回任务时间、模型、文件健康和按需预览，因此不能把“loopback”本身当作完整认证。

## Decision

- 只监听 `127.0.0.1`，不绑定所有网卡。
- 每次启动生成随机一次性 URL token，首次访问后立即失效并换成随机 HttpOnly、SameSite=Strict Cookie。
- Host 必须是当前端口的 `127.0.0.1` 或 `localhost`；有 Origin 时必须同源。
- 只允许 `GET` 和 `HEAD`，所有 API/静态响应禁用缓存。
- 使用 CSP、`X-Frame-Options: DENY`、`nosniff` 和 `Referrer-Policy: no-referrer`。
- session/thread/turn ID 使用固定字符和长度校验；客户端不能提供文件路径。
- CORS 默认不启用，也不提供远程访问开关。

## Alternatives considered

- **仅依赖 loopback：** 拒绝，不能防止浏览器侧 localhost 探测和误分享。
- **固定 API key：** 拒绝，需要长期密钥管理并可能进入历史或配置。
- **每次启动临时 token → Cookie：** 采用，不需要持久凭证且适合单用户本地工具。
- **绑定局域网并使用密码：** 拒绝，超出 MVP 威胁模型和远程传输能力。

## Consequences

- 服务重启后必须使用新 URL，旧 Cookie 失效。
- 不能直接把 API 嵌入其他网页或通过远程代理使用。
- 未来若支持远程/多用户，需要新的认证、TLS、授权、审计和威胁模型 ADR，不能简单放宽 Host/CORS。
- 安全头、认证和恶意 Origin 必须有自动化回归测试。

> 2026-09-04：固定 loopback endpoint 与跨进程 browser authorization 由 ADR-0034 替代本 ADR 的每进程 launch-token/session-secret 方案；loopback、Host/Origin、CSP、无 CORS 与敏感接口必须认证等安全目标继续保留。
