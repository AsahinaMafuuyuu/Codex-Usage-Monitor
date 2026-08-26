const state = {
  sessions: [],
  timeline: null,
  selectedId: null,
  snapshot: null,
  eventSource: null,
  search: "",
  sessionView: localStorage.getItem("codex-monitor-session-view") === "time" ? "time" : "project",
  connected: false,
};

const elements = Object.fromEntries(
  [
    "session-search", "session-count", "session-list", "health-dot", "health-label",
    "health-detail", "mobile-session-toggle", "connection-label", "last-update",
    "empty-state", "loading-state", "dashboard", "session-title", "session-project", "session-id",
    "session-version", "hero-total", "agent-count", "task-count", "active-task-count",
    "input-total", "cached-total", "cache-hit-rate", "output-total", "session-cost",
    "session-cost-coverage", "quota-plan", "quota-freshness", "quota-windows",
    "agent-tree", "toast",
  ].map((id) => [id, document.getElementById(id)]),
);

const tokenFormatter = new Intl.NumberFormat("zh-CN");
const compactFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

elements["session-search"].addEventListener("input", (event) => {
  state.search = event.target.value;
  renderSessions();
});
document.querySelectorAll("[data-session-view]").forEach((button) => {
  button.addEventListener("click", async () => {
    await withViewTransition(() => {
      state.sessionView = button.dataset.sessionView === "time" ? "time" : "project";
      localStorage.setItem("codex-monitor-session-view", state.sessionView);
      renderSessions();
    });
    if (state.sessionView === "time" && !state.timeline) {
      try {
        await ensureTimeline();
        await withViewTransition(() => renderSessions());
      } catch (error) {
        toast(`日期汇总失败：${error.message}`);
      }
    }
  });
});
elements["mobile-session-toggle"].addEventListener("click", () => document.body.classList.toggle("sessions-open"));
elements["session-list"].addEventListener("click", (event) => {
  const button = event.target.closest("[data-session-id]");
  if (button) void selectSession(button.dataset.sessionId);
});

await initialize();

async function initialize() {
  try {
    const payload = await fetchJson("/api/sessions");
    state.sessions = payload.sessions;
    renderSessions();
    if (state.sessionView === "time") {
      await ensureTimeline();
      renderSessions();
    }
    const remembered = localStorage.getItem("codex-monitor-session");
    const initial = state.sessions.find((item) => item.id === remembered)?.id ?? state.sessions[0]?.id;
    if (initial) await selectSession(initial);
    else setEmpty("还没有可读取的 Codex 会话", "确认 .codex/sessions 中存在 rollout 文件后刷新页面。");
  } catch (error) {
    setHealth({ status: "warning", recentErrors: [{ message: error.message }] });
    setEmpty("无法读取本地会话", error.message);
  }
}

async function ensureTimeline() {
  if (state.timeline) return state.timeline;
  state.timeline = await fetchJson("/api/timeline");
  return state.timeline;
}

async function selectSession(sessionId) {
  if (!sessionId) return;
  state.selectedId = sessionId;
  localStorage.setItem("codex-monitor-session", sessionId);
  await withViewTransition(() => {
    document.body.classList.remove("sessions-open");
    renderSessions();
    setLoading(true);
  });
  closeEvents();
  try {
    state.snapshot = await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
    await withViewTransition(() => {
      setLoading(false);
      renderDashboard();
    });
    connectEvents(sessionId);
  } catch (error) {
    toast(error.message);
    await withViewTransition(() => setEmpty("会话解析失败", "健康状态中保留了具体错误；原始 .codex 文件未被修改。"));
  }
}

function connectEvents(sessionId) {
  state.connected = false;
  setConnection("正在连接实时观察…", false);
  const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  state.eventSource = source;
  source.addEventListener("open", () => {
    state.connected = true;
    setConnection("实时观察中", true);
  });
  source.addEventListener("snapshot", (event) => {
    if (sessionId !== state.selectedId) return;
    state.snapshot = JSON.parse(event.data);
    renderDashboard();
  });
  source.addEventListener("quota", (event) => {
    if (!state.snapshot) return;
    state.snapshot.quota = JSON.parse(event.data);
    renderQuota();
  });
  source.addEventListener("health", (event) => setHealth(JSON.parse(event.data)));
  source.addEventListener("error", () => {
    state.connected = false;
    setConnection("实时连接正在重试", false);
  });
}

function closeEvents() {
  state.eventSource?.close();
  state.eventSource = null;
}

function renderSessions() {
  const query = state.search.trim().toLocaleLowerCase();
  const sessions = state.sessions.filter((session) =>
    `${session.title} ${session.id} ${session.projectPath ?? ""}`.toLocaleLowerCase().includes(query),
  );
  elements["session-count"].textContent = `${sessions.length}`;
  document.querySelectorAll("[data-session-view]").forEach((button) => {
    const active = button.dataset.sessionView === state.sessionView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (!sessions.length) {
    elements["session-list"].innerHTML = '<p class="empty-agent">没有匹配的会话</p>';
    return;
  }
  if (state.sessionView === "time") {
    elements["session-list"].innerHTML = renderSessionsByTime(sessions);
    return;
  }
  elements["session-list"].innerHTML = groupSessionsByProject(sessions).map((group) => `
    <details class="session-group" ${query || group.sessions.some((session) => session.id === state.selectedId) ? "open" : ""}>
      <summary class="project-heading">
        <span><strong>${escapeHtml(projectName(group.projectPath))}</strong><code title="${escapeHtml(group.projectPath || "未记录工程目录")}">${escapeHtml(group.projectPath || "未记录工程目录")}</code></span>
        <span class="project-meta"><b>${group.sessions.length}</b><i aria-hidden="true">›</i></span>
      </summary>
      <div class="project-sessions">${group.sessions.map((session) => `
          <button class="session-item ${session.id === state.selectedId ? "active" : ""}"
            type="button" data-session-id="${escapeHtml(session.id)}">
            <strong title="${escapeHtml(session.title || "未命名会话")}">${escapeHtml(session.title || "未命名会话")}</strong>
            <span><time title="${escapeHtml(session.updatedAt || "")}">${formatRelative(session.updatedAt)}</time><b>${session.agentCount || "—"} 智能体</b></span>
          </button>
        `).join("")}</div>
    </details>
  `).join("");
}

function renderSessionsByTime(sessions) {
  if (!state.timeline?.months?.length) {
    return '<p class="empty-agent">正在建立按日期索引…</p>';
  }
  const visibleIds = new Set(sessions.map((session) => session.id));
  const selectedDate = findTimelineDate(state.timeline, state.selectedId);
  const query = state.search.trim();
  const months = state.timeline.months.map((month) => ({
    ...month,
    days: month.days.map((day) => ({
      ...day,
      sessions: day.sessions.filter((session) => visibleIds.has(session.id)),
    })).filter((day) => day.sessions.length),
  })).filter((month) => month.days.length);
  if (!months.length) return '<p class="empty-agent">没有匹配的日期记录</p>';
  return months.map((month) => {
    const monthOpen = Boolean(query) || month.key === selectedDate?.slice(0, 7) || month.key === currentMonthKey();
    return `<details class="time-group" ${monthOpen ? "open" : ""}>
      <summary class="time-heading">
        <span><strong>${escapeHtml(formatMonthLabel(month.key))}</strong><code>${escapeHtml(month.key)}</code></span>
        <span class="time-meta"><b>${formatTokens(month.usage.totalTokens)}</b><i aria-hidden="true">›</i></span>
      </summary>
      <div class="time-days">${month.days.map((day) => {
        const dayOpen = Boolean(query) || day.key === selectedDate || day.key === currentDayKey();
        return `<details class="time-day" ${dayOpen ? "open" : ""}>
          <summary class="time-day-heading">
            <span><strong>${escapeHtml(formatDayLabel(day.key))}</strong><code>${escapeHtml(day.key)}</code></span>
            <span class="time-meta"><b>${formatTokens(day.usage.totalTokens)}</b><i aria-hidden="true">›</i></span>
          </summary>
          <div class="time-sessions">${day.sessions.map(renderTimeSession).join("")}</div>
        </details>`;
      }).join("")}</div>
    </details>`;
  }).join("");
}

function renderTimeSession(session) {
  const quality = summarizeQuality(session.qualityCounts);
  return `<button class="session-item time-session-item ${session.id === state.selectedId ? "active" : ""}"
    type="button" data-session-id="${escapeHtml(session.id)}">
    <strong title="${escapeHtml(session.title || "未命名会话")}">${escapeHtml(session.title || "未命名会话")}</strong>
    <span><time title="${escapeHtml(session.updatedAt || "")}">${formatTokens(session.usage.totalTokens)}</time><b>${escapeHtml(projectName(normalizeProjectPath(session.projectPath)))} · ${escapeHtml(quality)}</b></span>
  </button>`;
}

function findTimelineDate(timeline, sessionId) {
  if (!sessionId) return null;
  for (const month of timeline?.months ?? []) {
    for (const day of month.days) {
      if (day.sessions.some((session) => session.id === sessionId)) return day.key;
    }
  }
  return null;
}

function currentDayKey() {
  return localDateKey(new Date());
}

function currentMonthKey() {
  return currentDayKey().slice(0, 7);
}

function localDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function formatMonthLabel(value) {
  const date = new Date(`${value}-01T00:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "long",
  }).format(date);
}

function formatDayLabel(value) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", {
    month: "long", day: "numeric", weekday: "short",
  }).format(date);
}

function summarizeQuality(counts) {
  const attention = (counts?.discontinuity ?? 0) + (counts?.partial ?? 0) + (counts?.unknown ?? 0);
  if (attention) return `${attention} 条需注意`;
  if ((counts?.provisional ?? 0) > 0) return "实时";
  return "边界完整";
}

function renderDashboard() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const sessionIndex = state.sessions.findIndex((session) => session.id === snapshot.session.id);
  if (sessionIndex !== -1) {
    state.sessions[sessionIndex] = { ...state.sessions[sessionIndex], ...snapshot.session };
    renderSessions();
  }
  elements["empty-state"].hidden = true;
  elements.dashboard.hidden = false;
  const sessionTitle = snapshot.session.title || "未命名会话";
  elements["session-title"].textContent = sessionTitle;
  elements["session-title"].title = sessionTitle;
  elements["session-project"].textContent = normalizeProjectPath(snapshot.session.projectPath) || "未记录工程目录";
  elements["session-project"].title = snapshot.session.projectPath || "";
  elements["session-id"].textContent = snapshot.session.id;
  elements["session-id"].title = snapshot.session.id;
  elements["session-version"].textContent = snapshot.session.cliVersion || "版本未知";
  elements["hero-total"].textContent = formatTokens(snapshot.summary.subagentUsage?.totalTokens);
  elements["agent-count"].textContent = tokenFormatter.format(snapshot.summary.agentCount);
  elements["task-count"].textContent = tokenFormatter.format(snapshot.summary.taskCount);
  elements["active-task-count"].textContent = snapshot.summary.activeTasks
    ? `${snapshot.summary.activeTasks} 个任务运行中`
    : "无活动任务";
  const sessionUsage = snapshot.summary.totalUsage;
  elements["input-total"].textContent = formatTokens(sessionUsage?.inputTokens);
  elements["cached-total"].textContent = formatTokens(sessionUsage?.cachedInputTokens);
  elements["cache-hit-rate"].textContent = formatCacheHitRate(sessionUsage);
  elements["output-total"].textContent = formatTokens(sessionUsage?.outputTokens);
  elements["session-cost"].textContent = formatUsdAmount(snapshot.summary.totalCostEstimate?.amountUsd);
  elements["session-cost"].title = costSummaryTitle(snapshot.summary.totalCostEstimate, "整个会话");
  elements["session-cost-coverage"].textContent = costSummaryCoverage(snapshot.summary.totalCostEstimate);
  elements["last-update"].textContent = snapshot.health.lastUpdateAt
    ? `更新 ${formatDate(snapshot.health.lastUpdateAt)}`
    : `导入 ${formatDate(snapshot.session.importedAt)}`;
  renderQuota();
  renderAgents();
  setHealth(snapshot.health);
}

function renderQuota() {
  const quota = state.snapshot?.quota;
  if (!quota) {
    elements["quota-plan"].textContent = "暂无本地快照";
    elements["quota-freshness"].textContent = "不可用";
    elements["quota-freshness"].className = "freshness-chip stale";
    elements["quota-windows"].innerHTML = '<span class="empty-agent">等待下一条 rate_limits 记录</span>';
    return;
  }
  elements["quota-plan"].textContent = `${quota.planType || "Codex"} · ${quota.limitName || quota.limitId}`;
  elements["quota-freshness"].textContent = quota.stale ? "可能过期" : "最新";
  elements["quota-freshness"].className = `freshness-chip ${quota.stale ? "stale" : "fresh"}`;
  const windows = [quota.primary, quota.secondary].filter(Boolean);
  elements["quota-windows"].innerHTML = windows.map((window) => {
    const percent = clamp(window.usedPercent ?? 0, 0, 100);
    const windowLabel = formatWindow(window.windowMinutes);
    return `<div class="quota-window">
      <div class="quota-window-label"><span>${windowLabel} · ${formatReset(window.resetsAt)}</span><strong>${percent}%</strong></div>
      <progress class="quota-progress ${percent >= 80 ? "high" : ""}" max="100" value="${percent}" aria-label="${windowLabel}窗口已使用 ${percent}%">${percent}%</progress>
    </div>`;
  }).join("");
}

function renderAgents() {
  const agents = state.snapshot?.agents ?? [];
  if (!agents.length) {
    elements["agent-tree"].innerHTML = '<p class="empty-agent">这个会话尚未解析到智能体记录。</p>';
    return;
  }
  const byParent = new Map();
  for (const agent of agents) {
    const key = agent.parentThreadId && agents.some((item) => item.threadId === agent.parentThreadId)
      ? agent.parentThreadId
      : "__root__";
    const list = byParent.get(key) ?? [];
    list.push(agent);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.depth - b.depth || agentLabel(a).localeCompare(agentLabel(b)));
  const renderBranch = (parentId, depth) => (byParent.get(parentId) ?? []).map((agent) => {
    const active = agent.tasks.some((task) => task.status === "in_progress");
    const rootClass = agent.isRoot ? "root" : "";
    const children = renderBranch(agent.threadId, depth + 1);
    return `<div class="agent-branch depth-${Math.min(depth, 6)}">
      <div class="agent-node ${active ? "active" : ""} ${rootClass}">${renderAgent(agent)}</div>
      ${children ? `<div class="agent-children">${children}</div>` : ""}
    </div>`;
  }).join("");
  elements["agent-tree"].innerHTML = renderBranch("__root__", 0);
}

function renderAgent(agent) {
  const active = agent.tasks.some((task) => task.status === "in_progress");
  const shouldOpen = !agent.isRoot || active;
  const role = agentRole(agent);
  return `<details class="agent-card" ${shouldOpen ? "open" : ""}>
    <summary>
      <div class="agent-name">
        <div class="agent-title-line">
          <span class="role-badge ${agentRoleClass(role)}">${escapeHtml(role.toLocaleUpperCase())}</span>
          <strong>${escapeHtml(agentLabel(agent))}</strong>
        </div>
        <code>${escapeHtml(agent.agentPath || agent.threadId)}</code>
      </div>
      <div class="agent-stats">
        <div class="agent-stat task-count"><span>任务</span><strong>${agent.taskCount}</strong></div>
        <div class="agent-stat tokens"><span>自身 tokens</span><strong>${formatTokens(agent.ownUsage?.totalTokens)}</strong></div>
        <div class="agent-stat subtree"><span>含后代</span><strong>${formatTokens(agent.subtreeUsage?.totalTokens)}</strong></div>
        <div class="agent-stat cache-hit"><span>缓存命中</span><strong>${formatCacheHitRate(agent.ownUsage)}</strong></div>
        <div class="agent-stat cost-own" title="${escapeHtml(costSummaryTitle(agent.ownCostEstimate, "该智能体自身"))}"><span>自身 USD</span><strong>${formatUsdSummary(agent.ownCostEstimate)}</strong></div>
        <div class="agent-stat cost-subtree" title="${escapeHtml(costSummaryTitle(agent.subtreeCostEstimate, "该智能体及后代"))}"><span>含后代 USD</span><strong>${formatUsdSummary(agent.subtreeCostEstimate)}</strong></div>
      </div>
      <span class="agent-chevron" aria-hidden="true">›</span>
    </summary>
    ${renderTasks(agent)}
  </details>`;
}

function renderTasks(agent) {
  if (!agent.tasks.length) return '<div class="empty-agent">该智能体还没有持久化任务边界。</div>';
  return `<div class="task-table-wrap" role="region" tabindex="0" aria-label="任务审计表；任务与状态列固定，可横向滚动查看完整 13 列"><table class="task-table">
    <colgroup>
      <col class="col-task"><col class="col-status"><col class="col-start"><col class="col-duration">
      <col class="col-model"><col class="col-effort"><col class="col-input"><col class="col-cache">
      <col class="col-hit"><col class="col-output"><col class="col-total">
      <col class="col-cost"><col class="col-quality">
    </colgroup>
    <thead><tr>
      <th class="task-name-head">任务</th><th class="task-status-head">状态</th><th>开始</th><th>耗时</th><th>模型</th><th>强度</th><th>输入</th><th>缓存</th><th title="缓存输入 / 输入 tokens">命中率</th><th>输出</th><th>总计</th><th title="按当前标准 API 短上下文价格估算，不等于 Codex 订阅实际扣费">估算 USD</th><th>质量</th>
    </tr></thead>
    <tbody>${agent.tasks.map((task) => `
      <tr class="task-row">
        <td class="task-name-cell"><strong>Task ${task.sequence}</strong><code title="${escapeHtml(task.turnId)}">${escapeHtml(shortId(task.turnId))}</code></td>
        <td class="task-status-cell"><span class="status-chip ${escapeHtml(task.status)}">${statusLabel(task.status)}</span></td>
        <td title="${escapeHtml(task.startedAt || "")}">${formatDate(task.startedAt)}</td>
        <td>${formatDuration(task.durationMs, task.startedAt, task.completedAt)}</td>
        <td class="model-cell"><code title="${escapeHtml(task.model || "模型未知")}">${escapeHtml(task.model || "未知")}</code></td>
        <td><span class="effort-chip">${escapeHtml(effortLabel(task.effort))}</span></td>
        <td>${formatTokens(task.deltaUsage?.inputTokens)}</td>
        <td>${formatTokens(task.deltaUsage?.cachedInputTokens)}</td>
        <td>${formatCacheHitRate(task.deltaUsage)}</td>
        <td>${formatTokens(task.deltaUsage?.outputTokens)}</td>
        <td><strong>${formatTokens(task.deltaUsage?.totalTokens)}</strong></td>
        <td class="cost-cell" title="${escapeHtml(costEstimateTitle(task.costEstimate))}"><strong>${formatUsdEstimate(task.costEstimate)}</strong><span>${costEstimateLabel(task.costEstimate)}</span></td>
        <td><span class="quality-chip ${escapeHtml(task.quality)}">${qualityLabel(task.quality)}</span></td>
      </tr>
    `).join("")}</tbody>
  </table></div>`;
}

function setLoading(loading) {
  elements["loading-state"].hidden = !loading;
  if (loading) {
    elements["empty-state"].hidden = true;
    elements.dashboard.hidden = true;
  }
}

function setEmpty(title, detail) {
  elements.dashboard.hidden = true;
  elements["loading-state"].hidden = true;
  elements["empty-state"].hidden = false;
  elements["empty-state"].querySelector("h2").textContent = title;
  elements["empty-state"].querySelector("p:last-child").textContent = detail;
}

function setHealth(health) {
  const warning = health?.status === "warning";
  elements["health-dot"].className = `health-dot ${warning ? "warning" : ""}`;
  elements["health-label"].textContent = warning ? "观察器需要注意" : "只读观察正常";
  const parser = health?.parser;
  const errors = health?.recentErrors?.length ?? 0;
  elements["health-detail"].textContent = parser
    ? `${parser.files} files · ${parser.invalidLines} bad lines · ${parser.unknownRecords ?? 0} unknown · ${parser.skippedRecords ?? 0} skipped · ${errors} errors`
    : health?.repository
      ? `${health.repository.rolloutFiles} rollouts · ${health.repository.sessions} sessions`
      : "只读观察 .codex";
  elements["health-detail"].title = health?.recentErrors?.at(-1)?.message ?? "";
}

function setConnection(label, connected) {
  elements["connection-label"].textContent = label;
  elements["connection-label"].parentElement.classList.toggle("offline", !connected);
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => elements.toast.classList.remove("visible"), 3200);
}

async function withViewTransition(update) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof document.startViewTransition !== "function" || reduceMotion) {
    return await update();
  }
  const transition = document.startViewTransition(() => update());
  try {
    await transition.finished;
  } catch {
    // A newer interaction may supersede the current visual transition; DOM state is already committed.
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function agentLabel(agent) {
  if (agent.isRoot) return "主智能体";
  return agent.nickname || agent.agentPath?.split("/").filter(Boolean).at(-1) || `Agent ${shortId(agent.threadId)}`;
}

function agentRole(agent) {
  if (agent.isRoot) return "root";
  return typeof agent.role === "string" && agent.role.trim() ? agent.role.trim().toLocaleLowerCase() : "subagent";
}

function agentRoleClass(role) {
  const known = new Set([
    "root", "reviewer", "test-worker", "frontend-designer", "backend-fullstack-worker",
    "debugger", "explorer", "routine-worker", "worker", "default",
  ]);
  return known.has(role) ? `role-${role}` : "role-other";
}

function groupSessionsByProject(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const projectPath = normalizeProjectPath(session.projectPath);
    const key = projectPath ? projectPath.replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase() : "__ungrouped__";
    if (!groups.has(key)) groups.set(key, { projectPath, sessions: [] });
    groups.get(key).sessions.push(session);
  }
  return [...groups.values()];
}

function normalizeProjectPath(projectPath) {
  if (typeof projectPath !== "string" || !projectPath.trim()) return null;
  return projectPath.trim().replace(/^\\\\\?\\/u, "").replace(/[\\/]+$/u, "");
}

function projectName(projectPath) {
  if (!projectPath) return "未归类";
  return projectPath.split(/[\\/]/u).filter(Boolean).at(-1) || projectPath;
}

function formatTokens(value) {
  if (value == null) return "—";
  if (Math.abs(value) >= 100_000) return compactFormatter.format(value);
  return tokenFormatter.format(value);
}

function formatCacheHitRate(usage) {
  const input = usage?.inputTokens;
  const cached = usage?.cachedInputTokens;
  if (!Number.isFinite(input) || !Number.isFinite(cached) || input <= 0 || cached < 0 || cached > input) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(cached / input);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : dateFormatter.format(date);
}

function formatRelative(value) {
  if (!value) return "—";
  const age = Date.now() - Date.parse(value);
  if (!Number.isFinite(age)) return formatDate(value);
  if (age < 60_000) return "刚刚";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} 分钟前`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)} 小时前`;
  return formatDate(value);
}

function formatDuration(durationMs, startedAt, completedAt) {
  let value = durationMs;
  if (value == null && startedAt && completedAt) value = Date.parse(completedAt) - Date.parse(startedAt);
  if (value == null || value < 0) return "—";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatUsdEstimate(estimate) {
  const value = estimate?.status === "estimated" ? estimate.amountUsd : null;
  return formatUsdAmount(value);
}

function formatUsdSummary(summary) {
  const value = summary?.amountUsd;
  if (value == null || !Number.isFinite(value)) return "—";
  return `${summary.status === "partial" ? "≥" : ""}${formatUsdAmount(value)}`;
}

function formatUsdAmount(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.000001) return "<$0.000001";
  const maximumFractionDigits = value >= 100 ? 2 : value >= 1 ? 3 : value >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value);
}

function costSummaryCoverage(summary) {
  const estimated = summary?.estimatedTasks ?? 0;
  const unavailable = summary?.unavailableTasks ?? 0;
  if (estimated + unavailable === 0) return "暂无任务 · 标准 API 等值";
  if (summary?.status === "partial") return `${estimated} 已估算 · ${unavailable} 不可估算`;
  if (summary?.status === "estimated") return `${estimated} 个任务 · 标准 API 等值`;
  return `${unavailable} 个任务不可估算`;
}

function costSummaryTitle(summary, scope) {
  const estimated = summary?.estimatedTasks ?? 0;
  const unavailable = summary?.unavailableTasks ?? 0;
  if (estimated + unavailable === 0) return `${scope}暂无任务，因而没有费用估算。`;
  if (summary?.status === "partial") {
    return `${scope}有 ${estimated} 个任务已估算、${unavailable} 个任务不可估算；显示金额只是已知下限，不是 Codex 订阅实际扣费。`;
  }
  if (summary?.status === "estimated") {
    return `${scope}共 ${estimated} 个任务，按当前标准 API 短上下文价格估算；不等于 Codex 订阅实际扣费。`;
  }
  return `${scope}的 ${unavailable} 个任务缺少可审计的模型、价格或 token 明细，无法估算。`;
}

function costEstimateLabel(estimate) {
  if (estimate?.status !== "estimated") return "不可估算";
  return estimate.catalogStale ? "价目待复核" : "API 等值";
}

function costEstimateTitle(estimate) {
  if (!estimate || estimate.status !== "estimated") {
    return ({
      missing_model: "rollout 未记录任务模型，无法匹配官方价格。",
      unsupported_model: "该模型没有已验证的官方价格映射。",
      missing_usage: "任务缺少可计算的 token 差分。",
      incomplete_usage_breakdown: "任务缺少输入、缓存或输出 token 明细。",
      inconsistent_usage_breakdown: "任务 token 明细互相矛盾，未生成伪精确费用。",
    })[estimate?.reason] || "缺少可审计的模型或 token 明细。";
  }
  const rates = estimate.ratesPerMillion;
  const stale = estimate.catalogStale ? " 当前价目已到复核日期。" : "";
  return `${estimate.pricedModel} 当前标准 API 短上下文等值：输入 $${rates.input}/1M、缓存输入 $${rates.cachedInput}/1M、缓存写入 $${rates.cacheWriteInput}/1M、输出 $${rates.output}/1M。不等于 Codex 订阅实际扣费；未含长上下文、服务层级、区域和工具费用。${stale}`;
}

function formatWindow(minutes) {
  if (minutes == null) return "未知窗口";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}周`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}天`;
  if (minutes % 60 === 0) return `${minutes / 60}小时`;
  return `${minutes}分钟`;
}

function formatReset(value) {
  return value ? `${formatDate(value)}重置` : "重置时间未知";
}

function statusLabel(status) {
  return ({ completed: "完成", in_progress: "运行中", interrupted: "中止" })[status] || status;
}

function qualityLabel(quality) {
  return ({
    complete: "边界完整", provisional: "实时", estimated: "估算",
    partial: "部分", discontinuity: "计数中断", unknown: "未知",
  })[quality] || quality;
}

function effortLabel(effort) {
  return ({ none: "NONE", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "XHIGH", max: "MAX", ultra: "ULTRA" })[effort]
    || (effort ? String(effort).toLocaleUpperCase() : "未知");
}

function shortId(value) {
  return value?.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value || "—";
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[character]);
}
