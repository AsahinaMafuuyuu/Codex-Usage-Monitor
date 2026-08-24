# ADR-0006：使用 Node 内置模块和无框架页面

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

MVP 是单用户本地只读工具，界面规模小，数据流主要是 JSON snapshot 和 SSE。用户希望最小程度的页面/软件，并要求 Node.js 24、`node:sqlite`。引入 Web 框架、打包器和依赖树会增加安装、升级和供应链维护，而当前需求不需要其复杂能力。

## Decision

- 运行时要求 Node.js 24+。
- 服务使用 `node:http`、`node:sqlite`、文件系统、EventEmitter 和 child process 等内置模块。
- 前端使用原生 HTML、CSS、JavaScript 和 `EventSource`，不需要构建步骤。
- `npm start` 直接运行源文件，`npm test` 使用 Node test runner，`npm run check` 使用 `node --check`。
- 在功能规模明显增长前保持零运行时第三方依赖。

## Alternatives considered

- **Electron/Tauri 桌面包：** 暂不采用，MVP 不需要安装器、原生窗口或自动更新。
- **Express + React/Vite：** 暂不采用，当前路由和页面状态简单，框架成本高于收益。
- **Node 内置服务 + 无框架页面：** 采用，启动路径短、可审计面小、无需构建。

## Consequences

- 项目无需 `node_modules` 就能运行，交付和安全审查简单。
- 路由、模板和前端状态需要自行保持清晰；复杂度增长时应重新评估，而不是无条件坚持零依赖。
- 若未来引入依赖或构建步骤，必须记录动机、锁文件、更新策略和供应链影响。
