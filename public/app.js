const state = {
  sessions: [],
  timeline: null,
  selectedId: null,
  selectedDay: null,
  snapshot: null,
  eventSource: null,
  selectionVersion: 0,
  search: "",
  sessionView: localStorage.getItem("codex-monitor-session-view") === "time" ? "time" : "project",
  connected: false,
  quotaRefreshing: false,
  requestDetails: new Map(),
};

const elements = Object.fromEntries(
  [
    "session-search", "session-count", "session-list", "health-dot", "health-label",
    "health-detail", "mobile-session-toggle", "connection-label", "last-update",
    "empty-state", "loading-state", "dashboard", "session-title", "session-project", "session-id",
    "session-version", "hero-total", "agent-count", "task-count-label", "task-count", "active-task-count",
    "input-total", "cached-total", "cache-hit-rate", "output-total", "session-cost",
    "session-cost-coverage", "quota-plan", "quota-refresh", "quota-windows",
    "agent-tree", "toast",
  ].map((id) => [id, document.getElementById(id)]),
);

const tokenFormatter = new Intl.NumberFormat("zh-CN");
const compactFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

window.lucide?.createIcons({
  attrs: {
    "aria-hidden": "true",
    "stroke-width": 1.8,
  },
});

elements["session-search"].addEventListener("input", (event) => {
  state.search = event.target.value;
  renderSessions();
});
document.querySelectorAll("[data-session-view]").forEach((button) => {
  button.addEventListener("click", async () => {
    const nextView = button.dataset.sessionView === "time" ? "time" : "project";
    if (nextView === state.sessionView) return;
    if (nextView === "time") {
      try {
        await ensureTimeline();
      } catch (error) {
        toast(`日期汇总失败：${error.message}`);
        return;
      }
    }
    state.sessionView = nextView;
    localStorage.setItem("codex-monitor-session-view", state.sessionView);
    const day = nextView === "time" ? preferredTimelineDay(state.selectedId) : null;
    state.selectedDay = day;
    await withViewTransition(() => renderSessions());
    if (state.selectedId) await selectSession(state.selectedId, day);
  });
});
elements["mobile-session-toggle"].addEventListener("click", () => document.body.classList.toggle("sessions-open"));
elements["session-list"].addEventListener("click", (event) => {
  const button = event.target.closest("[data-session-id]");
  if (button) void selectSession(button.dataset.sessionId, button.dataset.sessionDay ?? null);
});
elements["agent-tree"].addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-task-toggle]");
  if (toggle) {
    void toggleTaskRequests(toggle.dataset.threadId, toggle.dataset.turnId);
    return;
  }
  const more = event.target.closest("[data-request-more]");
  if (more) void loadTaskRequests(more.dataset.threadId, more.dataset.turnId, { append: true });
});
elements["quota-refresh"].addEventListener("click", () => void refreshQuota());

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
    if (initial) {
      const day = state.sessionView === "time" ? preferredTimelineDay(initial) : null;
      await selectSession(initial, day);
    }
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

async function selectSession(sessionId, requestedDay = null) {
  if (!sessionId) return;
  const day = state.sessionView === "time"
    ? requestedDay ?? preferredTimelineDay(sessionId)
    : null;
  if (state.sessionView === "time" && !day) {
    toast("该会话没有可用的日期记录");
    return;
  }
  const selectionVersion = ++state.selectionVersion;
  const previousSelectionKey = `${state.selectedId ?? ""}|${state.selectedDay ?? ""}`;
  const nextSelectionKey = `${sessionId}|${day ?? ""}`;
  if (previousSelectionKey !== nextSelectionKey) state.requestDetails.clear();
  state.selectedId = sessionId;
  state.selectedDay = day;
  localStorage.setItem("codex-monitor-session", sessionId);
  if (day) rememberTimelineDay(sessionId, day);
  await withViewTransition(() => {
    document.body.classList.remove("sessions-open");
    syncSessionSelection();
    setLoading(true);
  });
  closeEvents();
  try {
    const query = day ? `?day=${encodeURIComponent(day)}` : "";
    const snapshot = await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}${query}`);
    if (selectionVersion !== state.selectionVersion) return;
    state.snapshot = snapshot;
    await withViewTransition(() => {
      setLoading(false);
      renderDashboard();
    });
    connectEvents(sessionId, day, selectionVersion);
  } catch (error) {
    if (selectionVersion !== state.selectionVersion) return;
    toast(error.message);
    await withViewTransition(() => setEmpty("会话解析失败", "健康状态中保留了具体错误；原始 .codex 文件未被修改。"));
  }
}

function connectEvents(sessionId, day, selectionVersion) {
  state.connected = false;
  setConnection("正在连接实时观察…", false);
  const query = day ? `?day=${encodeURIComponent(day)}` : "";
  const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events${query}`);
  state.eventSource = source;
  source.addEventListener("open", () => {
    state.connected = true;
    setConnection("实时观察中", true);
  });
  source.addEventListener("snapshot", (event) => {
    if (
      selectionVersion !== state.selectionVersion ||
      sessionId !== state.selectedId ||
      day !== state.selectedDay
    ) return;
    state.snapshot = JSON.parse(event.data);
    renderDashboard();
    void refreshStaleOpenRequestDetails();
    if (state.sessionView === "time") void refreshTimelineNavigation(selectionVersion);
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

async function refreshTimelineNavigation(selectionVersion) {
  try {
    const timeline = await fetchJson("/api/timeline");
    if (selectionVersion !== state.selectionVersion || state.sessionView !== "time") return;
    state.timeline = timeline;
    renderSessions();
  } catch (error) {
    if (selectionVersion === state.selectionVersion) toast(`日期汇总刷新失败：${error.message}`);
  }
}

function renderSessions() {
  const interaction = captureSessionListInteraction();
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
    restoreSessionListInteraction(interaction);
    return;
  }
  if (state.sessionView === "time") {
    elements["session-list"].innerHTML = renderSessionsByTime(sessions);
    restoreSessionListInteraction(interaction);
    return;
  }
  elements["session-list"].innerHTML = groupSessionsByProject(sessions).map((group) => `
    <details class="session-group" data-session-group-key="${escapeHtml(projectGroupKey(group.projectPath))}" ${query || group.sessions.some((session) => session.id === state.selectedId) ? "open" : ""}>
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
  restoreSessionListInteraction(interaction);
}

function captureSessionListInteraction() {
  const list = elements["session-list"];
  const detailsState = new Map();
  for (const details of list.querySelectorAll("details")) {
    const key = sessionDetailsKey(details);
    if (key) detailsState.set(key, details.open);
  }
  const focusedSessionId = list.contains(document.activeElement)
    ? document.activeElement.closest("[data-session-id]")?.dataset.sessionId ?? null
    : null;
  const focusedSessionDay = list.contains(document.activeElement)
    ? document.activeElement.closest("[data-session-id]")?.dataset.sessionDay ?? null
    : null;
  return { scrollTop: list.scrollTop, detailsState, focusedSessionId, focusedSessionDay };
}

function restoreSessionListInteraction(interaction) {
  if (!interaction) return;
  const list = elements["session-list"];
  for (const details of list.querySelectorAll("details")) {
    const key = sessionDetailsKey(details);
    if (key && interaction.detailsState.has(key)) details.open = interaction.detailsState.get(key);
  }
  if (interaction.focusedSessionId) {
    [...list.querySelectorAll("[data-session-id]")]
      .find((button) =>
        button.dataset.sessionId === interaction.focusedSessionId &&
        (button.dataset.sessionDay ?? null) === interaction.focusedSessionDay,
      )?.focus({ preventScroll: true });
  }
  list.scrollTop = interaction.scrollTop;
}

function sessionDetailsKey(details) {
  if (details.dataset.sessionGroupKey) return `project:${details.dataset.sessionGroupKey}`;
  if (details.dataset.timeMonth) return `month:${details.dataset.timeMonth}`;
  if (details.dataset.timeDay) return `day:${details.dataset.timeDay}`;
  return null;
}

function syncSessionSelection() {
  for (const button of elements["session-list"].querySelectorAll("[data-session-id]")) {
    const active = button.dataset.sessionId === state.selectedId && (
      state.sessionView === "project" || button.dataset.sessionDay === state.selectedDay
    );
    button.classList.toggle("active", active);
  }
}

function patchSessionNavigation(previousSession, nextSession) {
  syncSessionSelection();
  if (state.sessionView !== "project") return;
  if (projectGroupKey(previousSession.projectPath) !== projectGroupKey(nextSession.projectPath)) {
    renderSessions();
    return;
  }
  const button = findByData(elements["session-list"], "sessionId", nextSession.id);
  if (!button) return;
  const title = nextSession.title || "未命名会话";
  const titleElement = button.querySelector("strong");
  if (titleElement) {
    titleElement.textContent = title;
    titleElement.title = title;
  }
  const time = button.querySelector("time");
  if (time) {
    time.textContent = formatRelative(nextSession.updatedAt);
    time.title = nextSession.updatedAt || "";
  }
  const agentCount = button.querySelector("span > b");
  if (agentCount) agentCount.textContent = `${nextSession.agentCount || "—"} 智能体`;
}

function renderSessionsByTime(sessions) {
  if (!state.timeline?.months?.length) {
    return '<p class="empty-agent">正在建立按日期索引…</p>';
  }
  const visibleIds = new Set(sessions.map((session) => session.id));
  const selectedDate = state.selectedDay ?? findTimelineDate(state.timeline, state.selectedId);
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
    return `<details class="time-group" data-time-month="${escapeHtml(month.key)}" ${monthOpen ? "open" : ""}>
      <summary class="time-heading">
        <span><strong>${escapeHtml(formatMonthLabel(month.key))}</strong><code>${escapeHtml(month.key)}</code></span>
        <span class="time-meta" title="${escapeHtml(costSummaryTitle(month.costEstimate, `${formatMonthLabel(month.key)} `))}"><b>${formatTimelineUsageCost(month.usage, month.costEstimate)}</b><i aria-hidden="true">›</i></span>
      </summary>
      <div class="time-days">${month.days.map((day) => {
        const dayOpen = Boolean(query) || day.key === selectedDate || day.key === currentDayKey();
        return `<details class="time-day" data-time-day="${escapeHtml(day.key)}" ${dayOpen ? "open" : ""}>
          <summary class="time-day-heading">
            <span><strong>${escapeHtml(formatDayLabel(day.key))}</strong><code>${escapeHtml(day.key)}</code></span>
            <span class="time-meta" title="${escapeHtml(costSummaryTitle(day.costEstimate, `${formatDayLabel(day.key)} `))}"><b>${formatTimelineUsageCost(day.usage, day.costEstimate)}</b><i aria-hidden="true">›</i></span>
          </summary>
          <div class="time-sessions">${day.sessions.map((session) => renderTimeSession(session, day.key)).join("")}</div>
        </details>`;
      }).join("")}</div>
    </details>`;
  }).join("");
}

function renderTimeSession(session, day) {
  const project = projectName(normalizeProjectPath(session.projectPath));
  const costTitle = costSummaryTitle(session.costEstimate, "该会话");
  const active = session.id === state.selectedId && day === state.selectedDay;
  return `<button class="session-item time-session-item ${active ? "active" : ""}"
    type="button" data-session-id="${escapeHtml(session.id)}" data-session-day="${escapeHtml(day)}">
    <strong title="${escapeHtml(session.title || "未命名会话")}">${escapeHtml(session.title || "未命名会话")}</strong>
    <span>
      <time title="Total token: ${escapeHtml(formatTokens(session.usage?.totalTokens))}">${formatTokens(session.usage?.totalTokens)}</time>
      <b class="time-session-meta" title="${escapeHtml(`${project} · ${costTitle}`)}">
        <span class="time-session-project">${escapeHtml(project)}</span>
        <span class="time-session-separator" aria-hidden="true">·</span>
        <span class="time-session-cost">${formatTimelineSessionCost(session.costEstimate?.amountUsd)}</span>
      </b>
    </span>
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

function preferredTimelineDay(sessionId) {
  if (!sessionId) return null;
  const remembered = localStorage.getItem(`codex-monitor-session-day:${sessionId}`);
  if (remembered && timelineHasSessionDay(state.timeline, sessionId, remembered)) return remembered;
  return findTimelineDate(state.timeline, sessionId);
}

function rememberTimelineDay(sessionId, day) {
  localStorage.setItem(`codex-monitor-session-day:${sessionId}`, day);
}

function timelineHasSessionDay(timeline, sessionId, dayKey) {
  for (const month of timeline?.months ?? []) {
    const day = month.days.find((candidate) => candidate.key === dayKey);
    if (day?.sessions.some((session) => session.id === sessionId)) return true;
  }
  return false;
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

function renderDashboard() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const sessionIndex = state.sessions.findIndex((session) => session.id === snapshot.session.id);
  if (sessionIndex !== -1) {
    const previousSession = state.sessions[sessionIndex];
    const nextSession = { ...previousSession, ...snapshot.session };
    state.sessions[sessionIndex] = nextSession;
    patchSessionNavigation(previousSession, nextSession);
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
  const versionLabel = snapshot.session.cliVersion || "版本未知";
  elements["session-version"].textContent = snapshot.scope?.type === "day"
    ? `${versionLabel} · ${snapshot.scope.day} 当日`
    : versionLabel;
  elements["hero-total"].textContent = formatTokens(snapshot.summary.totalUsage?.totalTokens);
  elements["agent-count"].textContent = tokenFormatter.format(snapshot.summary.agentCount);
  elements["task-count"].textContent = tokenFormatter.format(snapshot.summary.taskCount);
  const dayScope = snapshot.scope?.type === "day";
  elements["task-count-label"].textContent = dayScope ? "活动任务" : "任务记录";
  elements["active-task-count"].textContent = `${tokenFormatter.format(snapshot.summary.modelRequestCount ?? 0)} Requests${
    snapshot.summary.activeTasks ? ` · ${snapshot.summary.activeTasks} 运行中` : ""
  }`;
  const sessionUsage = snapshot.summary.totalUsage;
  elements["input-total"].textContent = formatTokens(sessionUsage?.inputTokens);
  elements["cached-total"].textContent = formatTokens(sessionUsage?.cachedInputTokens);
  elements["cache-hit-rate"].textContent = formatCacheHitRate(sessionUsage);
  elements["output-total"].textContent = formatTokens(sessionUsage?.outputTokens);
  elements["session-cost"].textContent = formatUsdAmount(snapshot.summary.totalCostEstimate?.amountUsd);
  const costScopeLabel = snapshot.scope?.type === "day" ? `${snapshot.scope.day} 当日` : "整个会话";
  elements["session-cost"].title = costSummaryTitle(snapshot.summary.totalCostEstimate, costScopeLabel);
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
    elements["quota-windows"].innerHTML = '<span class="empty-agent">等待下一条 rate_limits 记录</span>';
    syncQuotaRefreshButton();
    return;
  }
  elements["quota-plan"].textContent = `${quota.planType || "Codex"} · ${quota.limitName || quota.limitId}`;
  const windows = [quota.primary, quota.secondary].filter(Boolean);
  elements["quota-windows"].innerHTML = windows.map((window) => {
    const usedPercent = clamp(window.usedPercent ?? 0, 0, 100);
    const remainingPercent = clamp(100 - usedPercent, 0, 100);
    const windowLabel = formatWindow(window.windowMinutes);
    return `<div class="quota-window">
      <div class="quota-window-label"><span>${windowLabel} · ${formatReset(window.resetsAt)}</span><strong>剩余 ${remainingPercent}%</strong></div>
      <progress class="quota-progress ${remainingPercent <= 20 ? "low" : ""}" max="100" value="${remainingPercent}" aria-label="${windowLabel}窗口剩余 ${remainingPercent}%">${remainingPercent}%</progress>
    </div>`;
  }).join("");
  syncQuotaRefreshButton();
}

async function refreshQuota() {
  if (state.quotaRefreshing) return;
  const previousObservedAt = state.snapshot?.quota?.observedAt ?? null;
  state.quotaRefreshing = true;
  syncQuotaRefreshButton();
  try {
    const payload = await fetchJson("/api/quota?refresh=1");
    if (state.snapshot) state.snapshot.quota = payload.quota;
    renderQuota();
    const currentObservedAt = payload.quota?.observedAt ?? null;
    if (currentObservedAt && currentObservedAt !== previousObservedAt) {
      toast(`额度已更新 · ${formatDate(currentObservedAt)}`);
    } else if (payload.quota) {
      toast("已重新扫描本地额度，暂未发现新的快照");
    } else {
      toast("已重新扫描，但尚未发现 rate_limits 记录");
    }
  } catch (error) {
    toast(`额度刷新失败：${error.message}`);
  } finally {
    state.quotaRefreshing = false;
    syncQuotaRefreshButton();
  }
}

function syncQuotaRefreshButton() {
  const button = elements["quota-refresh"];
  const quota = state.snapshot?.quota;
  button.disabled = state.quotaRefreshing;
  button.classList.toggle("refreshing", state.quotaRefreshing);
  button.setAttribute("aria-busy", String(state.quotaRefreshing));
  if (state.quotaRefreshing) {
    button.setAttribute("aria-label", "正在刷新账号额度");
    button.title = "正在重新扫描本地 Codex 额度快照";
    return;
  }
  button.setAttribute("aria-label", "刷新账号额度");
  button.title = quota?.observedAt
    ? `刷新账号额度 · 当前快照 ${formatDate(quota.observedAt)}`
    : "刷新账号额度";
}

function renderAgents() {
  const agents = state.snapshot?.agents ?? [];
  if (!agents.length) {
    if (!elements["agent-tree"].querySelector(":scope > .empty-agent")) {
      elements["agent-tree"].innerHTML = '<p class="empty-agent">这个会话尚未解析到智能体记录。</p>';
    }
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
  const anchor = captureVisualAnchor(elements["agent-tree"]);
  const structuralChanged = patchAgentBranches(elements["agent-tree"], byParent, "__root__", 0);
  if (structuralChanged) restoreVisualAnchor(elements["agent-tree"], anchor);
}

function patchAgentBranches(container, byParent, parentId, depth) {
  let structuralChanged = false;
  for (const child of [...container.children]) {
    if (!child.classList.contains("agent-branch")) {
      child.remove();
      structuralChanged = true;
    }
  }
  const desiredAgents = byParent.get(parentId) ?? [];
  const existing = new Map(
    [...container.children].map((branch) => [branch.dataset.agentId, branch]),
  );
  const desiredIds = new Set(desiredAgents.map((agent) => agent.threadId));

  desiredAgents.forEach((agent, index) => {
    let branch = existing.get(agent.threadId);
    if (!branch) {
      branch = createAgentBranch(agent, depth);
      structuralChanged = true;
    } else {
      structuralChanged = updateAgentBranch(branch, agent, depth) || structuralChanged;
    }
    const currentAtIndex = container.children[index] ?? null;
    if (currentAtIndex !== branch) {
      container.insertBefore(branch, currentAtIndex);
      structuralChanged = true;
    }

    const childAgents = byParent.get(agent.threadId) ?? [];
    let childContainer = directChildByClass(branch, "agent-children");
    if (childAgents.length) {
      if (!childContainer) {
        childContainer = document.createElement("div");
        childContainer.className = "agent-children";
        branch.append(childContainer);
        structuralChanged = true;
      }
      structuralChanged = patchAgentBranches(childContainer, byParent, agent.threadId, depth + 1) || structuralChanged;
    } else if (childContainer) {
      childContainer.remove();
      structuralChanged = true;
    }
  });

  for (const [agentId, branch] of existing) {
    if (!desiredIds.has(agentId)) {
      branch.remove();
      structuralChanged = true;
    }
  }
  return structuralChanged;
}

function createAgentBranch(agent, depth) {
  const branch = document.createElement("div");
  branch.className = `agent-branch depth-${Math.min(depth, 6)}`;
  branch.dataset.agentId = agent.threadId;
  const node = document.createElement("div");
  node.className = agentNodeClass(agent);
  node.innerHTML = renderAgent(agent);
  node.querySelector(":scope > .agent-card > summary").dataset.agentAnchorId = agent.threadId;
  branch.append(node);
  return branch;
}

function updateAgentBranch(branch, agent, depth) {
  let structuralChanged = false;
  for (const className of [...branch.classList]) {
    if (/^depth-\d+$/u.test(className)) branch.classList.remove(className);
  }
  branch.classList.add(`depth-${Math.min(depth, 6)}`);
  branch.dataset.agentId = agent.threadId;

  const node = branch.firstElementChild;
  node.className = agentNodeClass(agent);
  const details = node.querySelector(":scope > .agent-card");
  const summary = details?.querySelector(":scope > summary");
  if (summary) {
    summary.dataset.agentAnchorId = agent.threadId;
    summary.innerHTML = renderAgentSummary(agent);
  }
  structuralChanged = patchAgentTasks(details, agent.tasks) || structuralChanged;
  return structuralChanged;
}

function agentNodeClass(agent) {
  const active = agent.tasks.some((task) => task.status === "in_progress");
  return `agent-node${active ? " active" : ""}${agent.isRoot ? " root" : ""}`;
}

function renderAgent(agent) {
  const active = agent.tasks.some((task) => task.status === "in_progress");
  const shouldOpen = !agent.isRoot || active;
  return `<details class="agent-card" ${shouldOpen ? "open" : ""}>
    <summary>${renderAgentSummary(agent)}</summary>
    ${renderTasks(agent)}
  </details>`;
}

function renderAgentSummary(agent) {
  const role = agentRole(agent);
  const dayScope = isDayScope();
  return `<div class="agent-name">
      <div class="agent-title-line">
        <span class="role-badge ${agentRoleClass(role)}">${escapeHtml(role.toLocaleUpperCase())}</span>
        <strong>${escapeHtml(agentLabel(agent))}</strong>
      </div>
      <code>${escapeHtml(agent.agentPath || agent.threadId)}</code>
    </div>
    <div class="agent-stats">
      <div class="agent-stat task-count"><span>${dayScope ? "活动任务" : "任务"}</span><strong>${agent.taskCount}</strong></div>
      <div class="agent-stat requests"><span>Requests</span><strong>${agent.ownModelRequestCount ?? 0}</strong></div>
      <div class="agent-stat tokens"><span>自身 tokens</span><strong>${formatTokens(agent.ownUsage?.totalTokens)}</strong></div>
      <div class="agent-stat subtree"><span>含后代</span><strong>${formatTokens(agent.subtreeUsage?.totalTokens)}</strong></div>
      <div class="agent-stat cache-hit"><span>缓存命中</span><strong>${formatCacheHitRate(agent.ownUsage)}</strong></div>
      <div class="agent-stat cost-own" title="${escapeHtml(costSummaryTitle(agent.ownCostEstimate, "该智能体自身"))}"><span>自身 USD</span><strong>${formatUsdSummary(agent.ownCostEstimate)}</strong></div>
      <div class="agent-stat cost-subtree" title="${escapeHtml(costSummaryTitle(agent.subtreeCostEstimate, "该智能体及后代"))}"><span>含后代 USD</span><strong>${formatUsdSummary(agent.subtreeCostEstimate)}</strong></div>
    </div>
    <span class="agent-chevron" aria-hidden="true">›</span>`;
}

function renderTasks(agent) {
  if (!agent.tasks.length) return '<div class="empty-agent">该智能体还没有持久化任务边界。</div>';
  return renderTaskTableShell(agent.tasks.map(renderTaskRow).join(""));
}

function renderTaskTableShell(rows = "") {
  const dayScope = isDayScope();
  const columnCount = 14;
  const columns = dayScope
    ? `<col class="col-task"><col class="col-status"><col class="col-request-time"><col class="col-request-time"><col class="col-requests"><col class="col-model"><col class="col-effort"><col class="col-input"><col class="col-cache"><col class="col-hit"><col class="col-output"><col class="col-total"><col class="col-cost"><col class="col-quality">`
    : `<col class="col-task"><col class="col-status"><col class="col-start"><col class="col-duration"><col class="col-requests"><col class="col-model"><col class="col-effort"><col class="col-input"><col class="col-cache"><col class="col-hit"><col class="col-output"><col class="col-total"><col class="col-cost"><col class="col-quality">`;
  const headings = dayScope
    ? `<th class="task-name-head">Task</th><th class="task-status-head">状态</th><th>当日首请求</th><th>当日末请求</th><th>Requests</th><th>模型</th><th>推理强度</th><th>输入</th><th>缓存</th><th title="缓存输入 / 输入 tokens">命中率</th><th>输出</th><th>总计</th><th title="逐 verified usage unit 按事件发生时的订阅标准价与可证明 feature 计算；不是 Plus 实际扣费">估算 USD</th><th>质量</th>`
    : `<th class="task-name-head">任务</th><th class="task-status-head">状态</th><th>开始</th><th>耗时</th><th>Requests</th><th>模型</th><th>推理强度</th><th>输入</th><th>缓存</th><th title="缓存输入 / 输入 tokens">命中率</th><th>输出</th><th>总计</th><th title="逐 verified usage unit 按事件发生时的订阅标准价与可证明 feature 计算；不是 Plus 实际扣费">估算 USD</th><th>质量</th>`;
  return `<div class="task-table-wrap" data-scope-kind="${dayScope ? "day" : "session"}" role="region" tabindex="0" aria-label="${dayScope ? "当日任务活动" : "任务记录"}；任务与状态列固定，可横向滚动查看完整 ${columnCount} 列"><table class="task-table ${dayScope ? "day-scope" : "session-scope"}">
    <caption class="${dayScope ? "visually-hidden" : ""}">${dayScope ? "当日任务活动" : "任务记录"}</caption>
    <colgroup>${columns}</colgroup>
    <thead><tr>${headings}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderTaskRow(task) {
  return `<tr class="task-row" data-task-id="${escapeHtml(task.turnId)}" data-thread-id="${escapeHtml(task.threadId)}">${renderTaskCells(task)}</tr>`;
}

function renderTaskCells(task) {
  const detail = requestDetailState(task.threadId, task.turnId);
  const taskCell = `<td class="task-name-cell"><button class="task-request-toggle" type="button" data-task-toggle data-thread-id="${escapeHtml(task.threadId)}" data-turn-id="${escapeHtml(task.turnId)}" aria-expanded="${detail?.open ? "true" : "false"}"><strong>Task ${task.sequence}</strong><code title="${escapeHtml(task.turnId)}">${escapeHtml(shortId(task.turnId))}</code><span>${task.requestCount ?? 0} Requests</span></button></td>`;
  if (isDayScope()) {
    return `${taskCell}
    <td class="task-status-cell"><span class="status-chip ${escapeHtml(task.status)}">${statusLabel(task.status)}</span></td>
    <td title="${escapeHtml(task.firstRequestAt || "")}">${formatDate(task.firstRequestAt)}</td>
    <td title="${escapeHtml(task.lastRequestAt || "")}">${formatDate(task.lastRequestAt)}</td>
    <td><strong>${tokenFormatter.format(task.requestCount ?? 0)}</strong></td>
    <td class="model-cell"><code title="${escapeHtml(task.model || "模型未知")}">${escapeHtml(task.model || "未知")}</code></td>
    <td><span class="effort-chip">${escapeHtml(effortLabel(task.effort))}</span></td>
    <td>${formatTokens(task.deltaUsage?.inputTokens)}</td>
    <td>${formatTokens(task.deltaUsage?.cachedInputTokens)}</td>
    <td>${formatCacheHitRate(task.deltaUsage)}</td>
    <td>${formatTokens(task.deltaUsage?.outputTokens)}</td>
    <td><strong>${formatTokens(task.deltaUsage?.totalTokens)}</strong></td>
    <td class="cost-cell" title="${escapeHtml(costEstimateTitle(task.costEstimate))}"><strong>${formatUsdEstimate(task.costEstimate)}</strong><span>${costEstimateLabel(task.costEstimate)}</span></td>
    <td><span class="quality-chip ${escapeHtml(task.quality)}">${qualityLabel(task.quality)}</span></td>`;
  }
  return `${taskCell}
    <td class="task-status-cell"><span class="status-chip ${escapeHtml(task.status)}">${statusLabel(task.status)}</span></td>
    <td title="${escapeHtml(task.startedAt || "")}">${formatDate(task.startedAt)}</td>
    <td>${formatDuration(task.durationMs, task.startedAt, task.completedAt)}</td>
    <td><strong>${tokenFormatter.format(task.requestCount ?? 0)}</strong></td>
    <td class="model-cell"><code title="${escapeHtml(task.model || "模型未知")}">${escapeHtml(task.model || "未知")}</code></td>
    <td><span class="effort-chip">${escapeHtml(effortLabel(task.effort))}</span></td>
    <td>${formatTokens(task.deltaUsage?.inputTokens)}</td>
    <td>${formatTokens(task.deltaUsage?.cachedInputTokens)}</td>
    <td>${formatCacheHitRate(task.deltaUsage)}</td>
    <td>${formatTokens(task.deltaUsage?.outputTokens)}</td>
    <td><strong>${formatTokens(task.deltaUsage?.totalTokens)}</strong></td>
    <td class="cost-cell" title="${escapeHtml(costEstimateTitle(task.costEstimate))}"><strong>${formatUsdEstimate(task.costEstimate)}</strong><span>${costEstimateLabel(task.costEstimate)}</span></td>
    <td><span class="quality-chip ${escapeHtml(task.quality)}">${qualityLabel(task.quality)}</span></td>`;
}

function patchAgentTasks(details, tasks) {
  if (!details) return false;
  let structuralChanged = false;
  let tableWrap = directChildByClass(details, "task-table-wrap");
  let empty = directChildByClass(details, "empty-agent");
  if (!tasks.length) {
    if (tableWrap) {
      tableWrap.remove();
      structuralChanged = true;
    }
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "empty-agent";
      empty.textContent = "该智能体还没有持久化任务边界。";
      details.append(empty);
      structuralChanged = true;
    }
    return structuralChanged;
  }

  if (empty) {
    empty.remove();
    structuralChanged = true;
  }
  const desiredScopeKind = isDayScope() ? "day" : "session";
  if (tableWrap && tableWrap.dataset.scopeKind !== desiredScopeKind) {
    tableWrap.remove();
    tableWrap = null;
    structuralChanged = true;
  }
  if (!tableWrap) {
    tableWrap = createElementFromHtml(renderTaskTableShell());
    details.append(tableWrap);
    structuralChanged = true;
  }
  return patchTaskRows(tableWrap, tasks) || structuralChanged;
}

function patchTaskRows(tableWrap, tasks) {
  const tbody = tableWrap.querySelector("tbody");
  const existing = new Map(
    [...tbody.querySelectorAll(":scope > tr.task-row")].map((row) => [row.dataset.taskId, row]),
  );
  const desiredIds = new Set(tasks.map((task) => task.turnId));
  let structuralChanged = false;
  let insertionPoint = tbody.firstElementChild;

  tasks.forEach((task) => {
    let row = existing.get(task.turnId);
    if (!row) {
      row = document.createElement("tr");
      row.className = "task-row";
      row.dataset.taskId = task.turnId;
      structuralChanged = true;
    }
    row.dataset.threadId = task.threadId;
    row.innerHTML = renderTaskCells(task);
    if (insertionPoint !== row) {
      tbody.insertBefore(row, insertionPoint);
      structuralChanged = true;
    }
    structuralChanged = patchTaskRequestDetail(tbody, row, task) || structuralChanged;
    const detailRow = findTaskDetailRow(tbody, task.turnId);
    insertionPoint = (detailRow ?? row).nextElementSibling;
  });

  for (const [taskId, row] of existing) {
    if (!desiredIds.has(taskId)) {
      row.remove();
      findTaskDetailRow(tbody, taskId)?.remove();
      structuralChanged = true;
    }
  }
  return structuralChanged;
}

function patchTaskRequestDetail(tbody, taskRow, task) {
  const detail = requestDetailState(task.threadId, task.turnId);
  let detailRow = findTaskDetailRow(tbody, task.turnId);
  if (!detail?.open) {
    if (!detailRow) return false;
    detailRow.remove();
    return true;
  }
  let structuralChanged = false;
  if (!detailRow) {
    detailRow = document.createElement("tr");
    detailRow.className = "task-request-row";
    detailRow.dataset.taskDetailId = task.turnId;
    structuralChanged = true;
  }
  detailRow.innerHTML = `<td colspan="${taskColumnCount()}">${renderRequestDetail(detail, task)}</td>`;
  if (taskRow.nextElementSibling !== detailRow) {
    taskRow.after(detailRow);
    structuralChanged = true;
  }
  return structuralChanged;
}

function findTaskDetailRow(tbody, turnId) {
  return [...tbody.querySelectorAll(":scope > tr.task-request-row")]
    .find((row) => row.dataset.taskDetailId === turnId) ?? null;
}

function taskColumnCount() {
  return 14;
}

function isDayScope() {
  return state.snapshot?.scope?.type === "day";
}

function requestDetailKey(threadId, turnId) {
  return `${state.selectedId ?? ""}\u0000${state.selectedDay ?? ""}\u0000${threadId}\u0000${turnId}`;
}

function requestDetailState(threadId, turnId) {
  return state.requestDetails.get(requestDetailKey(threadId, turnId)) ?? null;
}

function currentTask(threadId, turnId) {
  for (const agent of state.snapshot?.agents ?? []) {
    const task = agent.tasks?.find((candidate) =>
      candidate.threadId === threadId && candidate.turnId === turnId
    );
    if (task) return task;
  }
  return null;
}

async function toggleTaskRequests(threadId, turnId) {
  const task = currentTask(threadId, turnId);
  if (!task) return;
  const key = requestDetailKey(threadId, turnId);
  const existing = state.requestDetails.get(key);
  if (existing) {
    existing.open = !existing.open;
    patchVisibleTaskDetail(threadId, turnId);
    if (existing.open && !existing.loaded && !existing.loading) {
      await loadTaskRequests(threadId, turnId);
    }
    return;
  }
  state.requestDetails.set(key, {
    threadId,
    turnId,
    open: true,
    loaded: false,
    loading: false,
    requests: [],
    nextCursor: null,
    projectionGeneration: null,
    error: null,
  });
  patchVisibleTaskDetail(threadId, turnId);
  await loadTaskRequests(threadId, turnId);
}

async function loadTaskRequests(threadId, turnId, { append = false } = {}) {
  const key = requestDetailKey(threadId, turnId);
  const detail = state.requestDetails.get(key);
  if (!detail || detail.loading || !detail.open) return;
  const selectionVersion = state.selectionVersion;
  detail.loading = true;
  detail.error = null;
  patchVisibleTaskDetail(threadId, turnId);
  try {
    const query = new URLSearchParams({ limit: "200" });
    if (state.selectedDay) query.set("day", state.selectedDay);
    if (append && detail.nextCursor) query.set("cursor", detail.nextCursor);
    const payload = await fetchJson(
      `/api/sessions/${encodeURIComponent(state.selectedId)}/tasks/${encodeURIComponent(threadId)}/${encodeURIComponent(turnId)}/requests?${query}`,
    );
    if (selectionVersion !== state.selectionVersion || state.requestDetails.get(key) !== detail) return;
    const merged = append ? [...detail.requests, ...payload.requests] : payload.requests;
    detail.requests = [...new Map(merged.map((request) => [request.requestId, request])).values()];
    detail.nextCursor = payload.nextCursor;
    detail.projectionGeneration = payload.projectionGeneration;
    detail.loaded = true;
  } catch (error) {
    if (selectionVersion === state.selectionVersion && state.requestDetails.get(key) === detail) {
      detail.error = error.message;
    }
  } finally {
    if (state.requestDetails.get(key) === detail) {
      detail.loading = false;
      patchVisibleTaskDetail(threadId, turnId);
    }
  }
}

function patchVisibleTaskDetail(threadId, turnId) {
  const row = [...elements["agent-tree"].querySelectorAll("tr.task-row")].find((candidate) =>
    candidate.dataset.threadId === threadId && candidate.dataset.taskId === turnId
  );
  if (!row) return;
  row.innerHTML = renderTaskCells(currentTask(threadId, turnId));
  patchTaskRequestDetail(row.parentElement, row, currentTask(threadId, turnId));
}

async function refreshStaleOpenRequestDetails() {
  const generation = Number(state.snapshot?.health?.projectionGeneration ?? 0);
  const jobs = [];
  for (const detail of state.requestDetails.values()) {
    if (!detail.open || !detail.loaded || detail.loading || detail.projectionGeneration === generation) continue;
    detail.loaded = false;
    detail.nextCursor = null;
    jobs.push(loadTaskRequests(detail.threadId, detail.turnId));
  }
  await Promise.all(jobs);
}

function renderRequestDetail(detail, task) {
  if (detail.error) {
    return `<div class="request-detail-state error">Request 明细读取失败：${escapeHtml(detail.error)}</div>`;
  }
  if (!detail.loaded && detail.loading) {
    return '<div class="request-detail-state">正在读取 canonical Requests…</div>';
  }
  if (!detail.requests.length) {
    return '<div class="request-detail-state">这个 Task 没有可展示的 canonical Request。</div>';
  }
  return `<div class="request-audit">
    <div class="request-audit-heading"><strong>Canonical Requests</strong><span>${detail.requests.length}${detail.nextCursor ? "+" : ""} 条已加载</span></div>
    <div class="request-audit-scroll"><table class="request-table">
      <thead><tr><th>时间</th><th>Input</th><th>Cached</th><th>Cache Write</th><th>Output</th><th>Reasoning</th><th>Total</th><th>Model</th><th>推理强度</th><th>Tier</th><th>USD</th></tr></thead>
      <tbody>${detail.requests.map((request) => renderRequestRow(request, task?.effort)).join("")}</tbody>
    </table></div>
    ${detail.nextCursor ? `<button class="request-more" type="button" data-request-more data-thread-id="${escapeHtml(detail.threadId)}" data-turn-id="${escapeHtml(detail.turnId)}" ${detail.loading ? "disabled" : ""}>${detail.loading ? "加载中…" : "加载更多"}</button>` : ""}
  </div>`;
}

function renderRequestRow(request, effort) {
  return `<tr>
    <td title="${escapeHtml(request.observedAt || "")}">${formatDate(request.observedAt)}</td>
    <td>${formatTokens(request.usage?.inputTokens)}</td>
    <td>${formatTokens(request.usage?.cachedInputTokens)}</td>
    <td>${formatTokens(request.usage?.cacheWriteInputTokens)}</td>
    <td>${formatTokens(request.usage?.outputTokens)}</td>
    <td>${formatTokens(request.usage?.reasoningOutputTokens)}</td>
    <td><strong>${formatTokens(request.usage?.totalTokens)}</strong></td>
    <td><code title="${escapeHtml(request.model || "模型未知")}">${escapeHtml(request.model || "未知")}</code></td>
    <td><span class="effort-chip">${escapeHtml(effortLabel(effort))}</span></td>
    <td>${escapeHtml(request.serviceTier || "未知")}</td>
    <td title="${escapeHtml(costEstimateTitle(request.costEstimate))}">${formatUsdEstimate(request.costEstimate)}</td>
  </tr>`;
}


function captureVisualAnchor(root) {
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  for (const candidate of root.querySelectorAll("[data-agent-anchor-id], [data-task-id]")) {
    const rect = candidate.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= viewportHeight) continue;
    if (candidate.dataset.taskId) return { type: "taskId", id: candidate.dataset.taskId, top: rect.top };
    return { type: "agentAnchorId", id: candidate.dataset.agentAnchorId, top: rect.top };
  }
  return null;
}

function restoreVisualAnchor(root, anchor) {
  if (!anchor) return;
  const candidate = findByData(root, anchor.type, anchor.id);
  if (!candidate) return;
  const delta = candidate.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) >= 0.5) window.scrollBy(0, delta);
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
    const key = projectGroupKey(projectPath);
    if (!groups.has(key)) groups.set(key, { projectPath, sessions: [] });
    groups.get(key).sessions.push(session);
  }
  return [...groups.values()];
}

function projectGroupKey(projectPath) {
  const normalized = normalizeProjectPath(projectPath);
  return normalized ? normalized.replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase() : "__ungrouped__";
}

function directChildByClass(parent, className) {
  return [...parent.children].find((child) => child.classList.contains(className)) ?? null;
}

function createElementFromHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function findByData(root, property, value) {
  return [...root.querySelectorAll(`[data-${property.replace(/[A-Z]/gu, (letter) => `-${letter.toLocaleLowerCase()}`)}]`)]
    .find((element) => element.dataset[property] === value) ?? null;
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
  return formatUsdAmount(value);
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

function formatTimelineUsageCost(usage, costEstimate) {
  return `${formatTokens(usage?.totalTokens)} · ${formatUsdAmount(costEstimate?.amountUsd)}`;
}

function formatTimelineSessionCost(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function costSummaryCoverage(summary) {
  const requests = (summary?.estimatedRequests ?? 0) +
    (summary?.partialRequests ?? 0) +
    (summary?.unavailableRequests ?? 0);
  if (requests === 0) return "暂无可计价请求 · 订阅标准价等值";
  if (summary?.status === "partial") {
    return `${summary.estimatedRequests ?? 0} 完整 · ${summary.partialRequests ?? 0} 部分 · ${summary.unavailableRequests ?? 0} 不可用`;
  }
  if (summary?.status === "estimated") return `${requests} 个请求 · 订阅标准价等值`;
  return `${requests} 个请求不可估算`;
}

function costSummaryTitle(summary, scope) {
  const requests = (summary?.estimatedRequests ?? 0) +
    (summary?.partialRequests ?? 0) +
    (summary?.unavailableRequests ?? 0);
  if (requests === 0) return `${scope}暂无可计价的 verified Request Ledger usage unit。`;
  if (summary?.status === "partial") {
    return `${scope}的订阅标准价等值存在 pricing evidence 缺口；显示金额仅为当前可证明部分，不是 Plus 实际扣费。${formatFeatureCoverage(summary.featureCoverage)}`;
  }
  if (summary?.status === "estimated") {
    return `${scope}共 ${requests} 个 verified usage unit，按事件发生时的历史订阅标准价及可证明的长上下文/Fast 条件估算；不是 Plus 实际扣费。`;
  }
  return `${scope}缺少可审计的历史模型价格或 request-level pricing evidence，无法估算。`;
}

function costEstimateLabel(estimate) {
  if (estimate?.status === "estimated") return "订阅标准价等值";
  if (estimate?.status === "partial") return "部分可估";
  return "不可估算";
}

function costEstimateTitle(estimate) {
  if (!estimate) return "缺少可审计的 request pricing evidence。";
  const requests = estimate.requestCount ?? 0;
  if (requests === 0) return "该任务没有可计价的 verified Request Ledger usage unit。";
  const rates = (estimate.rateVersions ?? []).join("、") || "历史价目不可用";
  const reasons = (estimate.reasons ?? []).join("、");
  const suffix = reasons ? ` 限制：${reasons}。` : "";
  return `按 ${requests} 个 verified usage unit 逐请求汇总；价目版本：${rates}。${formatFeatureCoverage(estimate.featureCoverage)}不是 Plus 实际扣费。${suffix}`;
}

function formatFeatureCoverage(coverage) {
  if (!coverage) return "";
  return ` 历史价：${coverage.historicalRate ?? "unknown"}；请求边界：${coverage.requestBoundary ?? "unknown"}；服务层级：${coverage.serviceTier ?? "unknown"}。`;
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
    complete: "已验证", provisional: "实时",
    partial: "部分已验证", unknown: "未知",
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
