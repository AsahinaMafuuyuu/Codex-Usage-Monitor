# ADR-0010：建立面向长期审计的字体职责与字号层级

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Phase 8 已经把界面从深色卡片仪表盘重构为暖色编辑式账页，但字体层级仍残留大量 `8px`、`9px` 辅助文字，并让 monospace 同时承担数据、说明、eyebrow、角色标签和表格文字。结果是视觉风格统一但阅读负担偏高，尤其在 Windows 高 DPI、长时间观察和任务表高密度场景中，小字号与字体角色混用会削弱扫描效率。

本界面的核心任务是持续观察项目、会话、智能体谱系、token、缓存、费用和数据质量，因此字体体系必须优先服务信息识别和长时间阅读，而不是仅追求编辑式装饰感。

## Decision

- 保留三套本地字体栈，但严格限制职责：display serif 只用于会话、章节、工程和智能体等实体标题；system sans 负责导航、正文、标签、状态、表头和说明；monospace 只负责路径、ID、模型、时间、token、比例、USD 等机器数据。
- 在 `:root` 定义可复用的字号 token：identifier `10px`、utility `11px`、label `12px`、body `14px`、data `12px`、entity `20px`。后续新增 UI 优先引用这些 token，而不是继续引入零散字号。
- 移除界面中的 `8px` / `9px` 文本。长 ID 和路径允许使用 `10px`；普通辅助说明不得低于 `11px`。
- Session 主标题由最大 `66px` 收敛到最大 `48px`，章节标题最大 `36px`，避免观测工作台被 landing-page 式大标题占据首屏。
- eyebrow、role badge、effort、状态、质量和 task header 使用 sans；它们表达 UI 语义而不是代码或机器值。
- token、USD、缓存命中率、时间等数据继续使用 monospace 和 tabular numerals，以维持跨行比较能力。

## Alternatives considered

- **整体把所有字号增加 1–2px：** 拒绝。只能缓解小字，不能解决 serif/sans/mono 职责混用和层级不稳定的问题。
- **全部改成 system sans：** 拒绝。可读性会稳定，但会丢失 Phase 8 已建立的编辑式实体层级和产品辨识度。
- **继续让 mono 承担所有元信息：** 拒绝。会把“辅助 UI”与“可审计机器数据”混成同一视觉语言，降低数据扫描效率。
- **角色化三字体体系并建立字号 token：** 采用。它保留现有视觉方向，同时为后续高密度优化提供稳定约束。

## Consequences

- 页面整体字号略增，但通过缩小 Session/Section 大标题控制首屏高度，总体信息密度不会按比例下降。
- 后续视觉迭代应先判断内容属于 entity、body、utility、data 还是 identifier，再选择字体与字号；不得用 mono 作为“小字样式”的默认选择。
- 新增低于 `10px` 的文本需要显式重新评审本 ADR；原则上不接受依赖极小文字维持密度的方案。
- 这项决策只处理 typography，不同时改变谱系缩进、任务表列结构或默认展开策略；这些应按 AGENTS.md 的前端版本控制规则形成后续独立 commit。
