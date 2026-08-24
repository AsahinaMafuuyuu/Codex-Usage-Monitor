const state = {
  sessions: [],
  selectedId: null,
  snapshot: null,
  eventSource: null,
  search: "",
  connected: false,
};

const elements = Object.fromEntries(
  [
    "session-search", "session-count", "session-list", "health-dot", "health-label",
    "health-detail", "mobile-session-toggle", "connection-label", "last-update",
    "empty-state", "loading-state", "dashboard", "session-title", "session-id",
    "session-version", "hero-total", "agent-count", "task-count", "active-task-count",
    "cached-total", "quota-plan", "quota-freshness", "quota-windows", "quota-observed",
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
elements["mobile-session-toggle"].addEventListener("click", () => document.body.classList.toggle("sessions-open"));
elements["session-list"].addEventListener("click", (event) => {
  const button = event.target.closest("[data-session-id]");
  if (button) void selectSession(button.dataset.sessionId);
});
elements["agent-tree"].addEventListener("click", (event) => {
  const button = event.target.closest("[data-preview-thread]");
  if (button) void togglePreview(button);
});

await initialize();

async function initialize() {
  try {
    const payload = await fetchJson("/api/sessions");
    state.sessions = payload.sessions;
    renderSessions();
    const remembered = localStorage.getItem("codex-monitor-session");
    const initial = state.sessions.find((item) => item.id === remembered)?.id ?? state.sessions[0]?.id;
    if (initial) await selectSession(initial);
    else setEmpty("还没有可读取的 Codex 会话", "确认 .codex/sessions 中存在 rollout 文件后刷新页面。");
  } catch (error) {
    setHealth({ status: "warning", recentErrors: [{ message: error.message }] });
    setEmpty("无法读取本地会话", error.message);
  }
}

async function selectSession(sessionId) {
  if (!sessionId) return;
  state.selectedId = sessionId;
  localStorage.setItem("codex-monitor-session", sessionId);
  document.body.classList.remove("sessions-open");
  renderSessions();
  setLoading(true);
  closeEvents();
  try {
    state.snapshot = await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
    renderDashboard();
    connectEvents(sessionId);
  } catch (error) {
    toast(error.message);
    setEmpty("会话解析失败", "健康状态中保留了具体错误；原始 .codex 文件未被修改。");
  } finally {
    setLoading(false);
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
    `${session.title} ${session.id}`.toLocaleLowerCase().includes(query),
  );
  elements["session-count"].textContent = `${sessions.length}`;
  if (!sessions.length) {
    elements["session-list"].innerHTML = '<p class="empty-agent">没有匹配的会话</p>';
    return;
  }
  elements["session-list"].innerHTML = sessions.map((session) => `
    <button class="session-item ${session.id === state.selectedId ? "active" : ""}"
      type="button" data-session-id="${escapeHtml(session.id)}">
      <strong>${escapeHtml(session.title || "未命名会话")}</strong>
      <span><time title="${escapeHtml(session.updatedAt || "")}">${formatRelative(session.updatedAt)}</time><b>${session.agentCount || "—"} agents</b></span>
    </button>
  `).join("");
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
  elements["session-title"].textContent = snapshot.session.title || "未命名会话";
  elements["session-id"].textContent = snapshot.session.id;
  elements["session-id"].title = snapshot.session.id;
  elements["session-version"].textContent = snapshot.session.cliVersion || "版本未知";
  elements["hero-total"].textContent = formatTokens(snapshot.summary.subagentUsage?.totalTokens);
  elements["agent-count"].textContent = tokenFormatter.format(snapshot.summary.agentCount);
  elements["task-count"].textContent = tokenFormatter.format(snapshot.summary.taskCount);
  elements["active-task-count"].textContent = snapshot.summary.activeTasks
    ? `${snapshot.summary.activeTasks} 个任务运行中`
    : "无活动任务";
  elements["cached-total"].textContent = formatTokens(snapshot.summary.subagentUsage?.cachedInputTokens);
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
    elements["quota-observed"].textContent = "额度是账号级快照，不归属于单个任务";
    return;
  }
  elements["quota-plan"].textContent = `${quota.planType || "Codex"} · ${quota.limitName || quota.limitId}`;
  elements["quota-freshness"].textContent = quota.stale ? "可能过期" : "最新";
  elements["quota-freshness"].className = `freshness-chip ${quota.stale ? "stale" : "fresh"}`;
  const windows = [
    ["主窗口", quota.primary],
    ["次窗口", quota.secondary],
  ].filter(([, value]) => value);
  elements["quota-windows"].innerHTML = windows.map(([label, window]) => {
    const percent = clamp(window.usedPercent ?? 0, 0, 100);
    return `<div class="quota-window">
      <div class="quota-window-label"><span>${label} · ${formatWindow(window.windowMinutes)}</span><strong>${percent}%</strong></div>
      <progress class="quota-progress ${percent >= 80 ? "high" : ""}" max="100" value="${percent}" aria-label="${label}已使用 ${percent}%">${percent}%</progress>
    </div>`;
  }).join("");
  elements["quota-observed"].textContent = `观测 ${formatDate(quota.observedAt)} · 重置 ${formatReset(quota.primary?.resetsAt)}`;
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
    return `<div class="agent-node depth-${Math.min(depth, 6)} ${active ? "active" : ""} ${rootClass}">
      ${renderAgent(agent)}
    </div>${renderBranch(agent.threadId, depth + 1)}`;
  }).join("");
  elements["agent-tree"].innerHTML = renderBranch("__root__", 0);
}

function renderAgent(agent) {
  const active = agent.tasks.some((task) => task.status === "in_progress");
  const shouldOpen = !agent.isRoot || active;
  return `<details class="agent-card" ${shouldOpen ? "open" : ""}>
    <summary>
      <div class="agent-name">
        <strong>${escapeHtml(agentLabel(agent))}</strong>
        <span>${escapeHtml(agent.agentPath || agent.threadId)} · ${escapeHtml(agent.role || (agent.isRoot ? "root" : "subagent"))}</span>
      </div>
      <div class="agent-stat"><span>任务</span><strong>${agent.taskCount}</strong></div>
      <div class="agent-stat tokens"><span>自身 tokens</span><strong>${formatTokens(agent.ownUsage?.totalTokens)}</strong></div>
      <div class="agent-stat subtree"><span>含后代</span><strong>${formatTokens(agent.subtreeUsage?.totalTokens)}</strong></div>
      <span class="agent-chevron" aria-hidden="true">›</span>
    </summary>
    ${renderTasks(agent)}
  </details>`;
}

function renderTasks(agent) {
  if (!agent.tasks.length) return '<div class="empty-agent">该智能体还没有持久化任务边界。</div>';
  return `<div class="task-table-wrap"><table class="task-table">
    <thead><tr>
      <th>任务</th><th>状态</th><th>开始</th><th>耗时</th><th>输入</th><th>缓存</th><th>输出</th><th>推理</th><th>总计</th><th>质量</th><th>指令</th>
    </tr></thead>
    <tbody>${agent.tasks.map((task) => `
      <tr class="task-row">
        <td class="task-name-cell"><strong>Task ${task.sequence}</strong><code title="${escapeHtml(task.turnId)}">${escapeHtml(shortId(task.turnId))}</code></td>
        <td><span class="status-chip ${escapeHtml(task.status)}">${statusLabel(task.status)}</span></td>
        <td title="${escapeHtml(task.startedAt || "")}">${formatDate(task.startedAt)}</td>
        <td>${formatDuration(task.durationMs, task.startedAt, task.completedAt)}</td>
        <td>${formatTokens(task.deltaUsage?.inputTokens)}</td>
        <td>${formatTokens(task.deltaUsage?.cachedInputTokens)}</td>
        <td>${formatTokens(task.deltaUsage?.outputTokens)}</td>
        <td>${formatTokens(task.deltaUsage?.reasoningOutputTokens)}</td>
        <td><strong>${formatTokens(task.deltaUsage?.totalTokens)}</strong></td>
        <td><span class="quality-chip ${escapeHtml(task.quality)}">${qualityLabel(task.quality)}</span></td>
        <td><button class="preview-button" type="button" data-preview-thread="${escapeHtml(task.threadId)}" data-preview-turn="${escapeHtml(task.turnId)}">展开</button></td>
      </tr>
      <tr class="preview-row" id="preview-${escapeHtml(task.threadId)}-${escapeHtml(task.turnId)}" hidden><td colspan="11"><div class="preview-content">正在读取本地原始日志…</div></td></tr>
    `).join("")}</tbody>
  </table></div>`;
}

async function togglePreview(button) {
  const row = document.getElementById(`preview-${button.dataset.previewThread}-${button.dataset.previewTurn}`);
  if (!row) return;
  if (!row.hidden) {
    row.hidden = true;
    button.textContent = "展开";
    return;
  }
  row.hidden = false;
  button.textContent = "收起";
  if (row.dataset.loaded) return;
  try {
    const preview = await fetchJson(`/api/tasks/${encodeURIComponent(button.dataset.previewThread)}/${encodeURIComponent(button.dataset.previewTurn)}/preview`);
    row.querySelector(".preview-content").textContent = preview.available ? preview.text : preview.reason;
    row.dataset.loaded = "true";
  } catch (error) {
    row.querySelector(".preview-content").textContent = error.message;
  }
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

function formatTokens(value) {
  if (value == null) return "—";
  if (Math.abs(value) >= 100_000) return compactFormatter.format(value);
  return tokenFormatter.format(value);
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

function formatWindow(minutes) {
  if (minutes == null) return "未知窗口";
  if (minutes % 10_080 === 0) return `${minutes / 10_080} 周`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function formatReset(value) {
  return value ? formatDate(value) : "—";
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

function shortId(value) {
  return value?.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value || "—";
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[character]);
}
