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
  diagnostics: null,
  highlightedRequestId: null,
  requestInspector: {
    open: false,
    requestId: null,
    loading: false,
    error: null,
    payload: null,
    activeTab: "interaction",
    inputContext: {
      loading: false,
      error: null,
      payload: null,
      abortController: null,
    },
    stale: false,
    selectionVersion: 0,
    projectionGeneration: null,
    abortController: null,
    trigger: null,
    restoreFocusOnClose: true,
  },
};

const REQUEST_PAGE_SIZE = 10;
const REQUEST_PAGE_SIZE_OPTIONS = [5, 10];

const elements = Object.fromEntries(
  [
    "session-search", "session-count", "session-list", "health-dot", "health-label",
    "health-detail", "mobile-session-toggle", "connection-label", "last-update",
    "empty-state", "loading-state", "dashboard", "session-title", "session-project", "session-id",
    "session-version", "hero-total", "agent-count", "task-count-label", "task-count", "active-task-count",
    "input-total", "cached-total", "cache-hit-rate", "output-total", "session-cost",
    "session-cost-coverage", "quota-plan", "quota-refresh", "quota-windows",
    "diagnostics-summary", "diagnostics-toggle", "diagnostics-panel", "diagnostics-state", "diagnostics-findings",
    "diagnostic-alert-summary", "diagnostic-alert-snooze", "diagnostic-alert-policy-form",
    "diagnostic-budget-usd", "diagnostic-alert-severity", "diagnostic-alert-cooldown", "diagnostic-alerts",
    "agent-tree", "request-inspector", "request-inspector-title", "request-inspector-evidence",
    "request-inspector-body", "request-inspector-close", "toast",
  ].map((id) => [id, document.getElementById(id)]),
);

const tokenFormatter = new Intl.NumberFormat("zh-CN");
const compactFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

refreshLucideIcons();
installLiveQaHooks();

function refreshLucideIcons() {
  window.lucide?.createIcons({
    attrs: {
      "aria-hidden": "true",
      "stroke-width": 1.8,
    },
  });
}

function installLiveQaHooks() {
  if (!window.__codexLiveUiQa || typeof window.__codexLiveUiQa !== "object") return;
  window.__codexLiveUiQa.renderRequestContentItem = renderRequestContentItem;
}

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
  const requestInspect = event.target.closest("[data-request-inspect]");
  if (requestInspect) {
    void openRequestInspector(requestInspect);
    return;
  }
  const requestCollapse = event.target.closest("[data-request-collapse]");
  if (requestCollapse) {
    void toggleTaskRequests(requestCollapse.dataset.threadId, requestCollapse.dataset.turnId, { forceOpen: false });
    return;
  }
  const toggle = event.target.closest("[data-task-toggle]");
  if (toggle) {
    void toggleTaskRequests(toggle.dataset.threadId, toggle.dataset.turnId);
    return;
  }
  const requestPageSize = event.target.closest("[data-request-page-size]");
  if (requestPageSize) {
    void setRequestPageSize(
      requestPageSize.dataset.threadId,
      requestPageSize.dataset.turnId,
      Number(requestPageSize.dataset.requestPageSize),
    );
    return;
  }
  const requestPage = event.target.closest("[data-request-page-action], [data-request-page-number], [data-request-page-jump-submit]");
  if (requestPage) {
    void handleRequestPageAction(requestPage);
    return;
  }
});
elements["agent-tree"].addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const requestJump = event.target.closest("[data-request-page-jump]");
  if (requestJump) {
    event.preventDefault();
    void jumpRequestPageFromInput(requestJump);
  }
});
elements["agent-tree"].addEventListener("wheel", routeTaskWheelToWorkspace, { passive: false });
elements["quota-refresh"].addEventListener("click", () => void refreshQuota());
elements["diagnostics-toggle"].addEventListener("click", () => void toggleDiagnosticsPanel());
elements["diagnostics-panel"].addEventListener("click", (event) => {
  const alertAck = event.target.closest("[data-diagnostic-alert-ack]");
  if (alertAck) {
    void acknowledgeDiagnosticAlert(alertAck.dataset.diagnosticAlertAck);
    return;
  }
  const alertLocate = event.target.closest("[data-diagnostic-alert-locate]");
  if (alertLocate) {
    const alert = state.diagnostics?.alertsReport?.alerts?.find(
      (candidate) => candidate.alertId === alertLocate.dataset.diagnosticAlertLocate,
    );
    if (alert?.locator) void locateDiagnosticRequest({ locator: alert.locator });
    return;
  }
  const control = event.target.closest("[data-diagnostic-locate]");
  if (!control) return;
  const finding = state.diagnostics?.report?.findings?.find(
    (candidate) => candidate.findingId === control.dataset.diagnosticLocate,
  );
  if (finding) void locateDiagnosticRequest(finding);
});
elements["diagnostic-alert-policy-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  void saveDiagnosticAlertPolicy();
});
elements["diagnostic-alert-snooze"].addEventListener("click", () => void snoozeDiagnosticAlerts());
elements["request-inspector-close"].addEventListener("click", () => closeRequestInspector());
elements["request-inspector"].addEventListener("click", (event) => {
  const tab = event.target.closest("[data-request-inspector-tab]");
  if (tab) {
    const nextTab = tab.dataset.requestInspectorTab === "input_context" ? "input_context" : "interaction";
    state.requestInspector.activeTab = nextTab;
    renderRequestInspector();
    if (nextTab === "input_context" && !state.requestInspector.inputContext.payload) {
      void loadRequestInputContext();
    }
    return;
  }
  const refresh = event.target.closest("[data-request-inspector-refresh]");
  if (refresh) {
    if (state.requestInspector.activeTab === "input_context") void loadRequestInputContext({ force: true });
    else void refreshRequestInspector();
  }
});
elements["request-inspector"].addEventListener("close", () => releaseRequestInspectorContent());
elements["request-inspector"].addEventListener("cancel", () => {
  state.requestInspector.restoreFocusOnClose = true;
});

function routeTaskWheelToWorkspace(event) {
  const wrap = event.target.closest?.(".task-table-wrap");
  if (!wrap || !event.deltaY || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
  const maxScrollTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
  const canScrollVertically = maxScrollTop > 1;
  const atTop = wrap.scrollTop <= 1;
  const atBottom = wrap.scrollTop >= maxScrollTop - 1;
  const shouldChain = !canScrollVertically || (event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom);
  if (!shouldChain) return;
  const workspace = wrap.closest(".workspace") ?? document.querySelector(".workspace");
  if (!workspace) return;
  const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? workspace.clientHeight
      : 1;
  event.preventDefault();
  workspace.scrollTop += event.deltaY * deltaScale;
}

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
  if (previousSelectionKey !== nextSelectionKey) {
    closeRequestInspector({ restoreFocus: false });
    state.requestDetails.clear();
    state.diagnostics = createDiagnosticsState(nextSelectionKey);
    state.highlightedRequestId = null;
  }
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
    void loadDiagnostics(selectionVersion);
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
    markRequestInspectorStaleIfNeeded();
    renderDashboard();
    void refreshStaleOpenRequestDetails();
    void refreshDiagnosticsIfStale();
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
  renderDiagnostics();
  renderAgents();
  setHealth(snapshot.health);
}

function renderQuota() {
  const quota = state.snapshot?.quota;
  if (!quota) {
    elements["quota-plan"].textContent = "暂无官方额度";
    elements["quota-windows"].innerHTML = '<span class="empty-agent">等待 Codex Usage 返回额度</span>';
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
  const previousQuotaSignature = quotaValueSignature(state.snapshot?.quota);
  state.quotaRefreshing = true;
  syncQuotaRefreshButton();
  try {
    const payload = await fetchJson("/api/quota?refresh=1");
    if (state.snapshot) state.snapshot.quota = payload.quota;
    renderQuota();
    const currentObservedAt = payload.quota?.observedAt ?? null;
    if (payload.quota && quotaValueSignature(payload.quota) !== previousQuotaSignature) {
      toast(`额度已更新 · ${formatDate(currentObservedAt)}`);
    } else if (payload.quota) {
      toast("已查询官方 Codex Usage，额度暂无变化");
    } else {
      toast("官方 Codex Usage 暂未返回额度");
    }
  } catch (error) {
    toast(`额度刷新失败：${error.message}`);
  } finally {
    state.quotaRefreshing = false;
    syncQuotaRefreshButton();
  }
}

function quotaValueSignature(quota) {
  if (!quota) return "";
  return JSON.stringify({
    planType: quota.planType ?? null,
    limitId: quota.limitId ?? null,
    primary: quota.primary ?? null,
    secondary: quota.secondary ?? null,
    credits: quota.credits ?? null,
  });
}

function syncQuotaRefreshButton() {
  const button = elements["quota-refresh"];
  const quota = state.snapshot?.quota;
  button.disabled = state.quotaRefreshing;
  button.classList.toggle("refreshing", state.quotaRefreshing);
  button.setAttribute("aria-busy", String(state.quotaRefreshing));
  if (state.quotaRefreshing) {
    button.setAttribute("aria-label", "正在刷新账号额度");
    button.title = "正在查询官方 Codex Usage";
    return;
  }
  button.setAttribute("aria-label", "刷新账号额度");
  button.title = quota?.observedAt
    ? `刷新账号额度 · 当前快照 ${formatDate(quota.observedAt)}`
    : "刷新账号额度";
}

function createDiagnosticsState(selectionKey) {
  return {
    selectionKey,
    open: false,
    loading: false,
    loaded: false,
    error: null,
    report: null,
    alertsReport: null,
    alertsLoading: false,
    alertsError: null,
    requestFindings: new Map(),
    renderVersion: 0,
  };
}

async function loadDiagnosticAlerts(selectionVersion, { force = false } = {}) {
  if (!state.selectedId || selectionVersion !== state.selectionVersion) return;
  const diagnostics = state.diagnostics;
  if (!diagnostics || diagnostics.alertsLoading || (diagnostics.alertsReport && !force)) return;
  diagnostics.alertsLoading = true;
  diagnostics.alertsError = null;
  renderDiagnosticAlerts();
  try {
    const report = await fetchJson(
      `/api/sessions/${encodeURIComponent(state.selectedId)}/diagnostic-alerts`,
    );
    if (selectionVersion !== state.selectionVersion || state.diagnostics !== diagnostics) return;
    diagnostics.alertsReport = report;
  } catch (error) {
    if (selectionVersion === state.selectionVersion && state.diagnostics === diagnostics) {
      diagnostics.alertsError = error.message;
    }
  } finally {
    if (state.diagnostics === diagnostics) diagnostics.alertsLoading = false;
    renderDiagnosticAlerts();
  }
}

async function loadDiagnostics(selectionVersion, { force = false } = {}) {
  if (!state.selectedId || selectionVersion !== state.selectionVersion) return;
  const selectionKey = `${state.selectedId}|${state.selectedDay ?? ""}`;
  let diagnostics = state.diagnostics;
  if (!diagnostics || diagnostics.selectionKey !== selectionKey) {
    diagnostics = createDiagnosticsState(selectionKey);
    state.diagnostics = diagnostics;
  }
  if (diagnostics.loading || (diagnostics.loaded && !force)) return;
  diagnostics.loading = true;
  diagnostics.error = null;
  renderDiagnostics();
  try {
    const query = state.selectedDay ? `?day=${encodeURIComponent(state.selectedDay)}` : "";
    const [localReport, advancedReport, behavioralReport] = await Promise.all([
      fetchJson(`/api/sessions/${encodeURIComponent(state.selectedId)}/diagnostics${query}`),
      fetchJson(`/api/sessions/${encodeURIComponent(state.selectedId)}/advanced-diagnostics${query}`),
      fetchJson(`/api/sessions/${encodeURIComponent(state.selectedId)}/behavioral-diagnostics${query}`),
    ]);
    if (
      selectionVersion !== state.selectionVersion ||
      state.diagnostics !== diagnostics ||
      diagnostics.selectionKey !== `${state.selectedId}|${state.selectedDay ?? ""}`
    ) return;
    diagnostics.report = combineDiagnosticsReports(localReport, advancedReport, behavioralReport);
    diagnostics.loaded = true;
    diagnostics.requestFindings = groupDiagnosticsByRequest(diagnostics.report.findings ?? []);
    diagnostics.renderVersion += 1;
    renderDiagnostics();
    refreshOpenRequestDiagnosticMarkers();
  } catch (error) {
    if (selectionVersion === state.selectionVersion && state.diagnostics === diagnostics) {
      diagnostics.error = error.message;
      diagnostics.loaded = false;
      renderDiagnostics();
    }
  } finally {
    if (state.diagnostics === diagnostics) diagnostics.loading = false;
    renderDiagnostics();
  }
}

function refreshDiagnosticsIfStale() {
  const diagnostics = state.diagnostics;
  if (!diagnostics?.loaded || diagnostics.loading || !diagnostics.report) return;
  const currentGeneration = Number(state.snapshot?.health?.projectionGeneration ?? 0);
  if (Number(diagnostics.report.projectionGeneration ?? -1) === currentGeneration) return;
  return loadDiagnostics(state.selectionVersion, { force: true });
}

function combineDiagnosticsReports(localReport, advancedReport, behavioralReport) {
  const findings = [
    ...(localReport?.findings ?? []).map((finding) => ({ ...finding, family: finding.family ?? "local" })),
    ...(advancedReport?.findings ?? []),
    ...(behavioralReport?.findings ?? []),
  ];
  return {
    scope: behavioralReport?.scope ?? advancedReport?.scope ?? localReport?.scope ?? { type: "session" },
    projectionGeneration: Math.max(
      Number(localReport?.projectionGeneration ?? 0),
      Number(advancedReport?.projectionGeneration ?? 0),
      Number(behavioralReport?.projectionGeneration ?? 0),
    ),
    stale: Boolean(localReport?.stale || advancedReport?.stale || behavioralReport?.stale),
    policies: {
      local: localReport?.policy ?? null,
      advanced: advancedReport?.policy ?? null,
      behavioral: behavioralReport?.policy ?? null,
    },
    coverage: {
      advanced: advancedReport?.coverage ?? null,
      behavioral: behavioralReport?.coverage ?? null,
    },
    summary: summarizeDiagnosticFindings(findings),
    findings,
  };
}

function summarizeDiagnosticFindings(findings) {
  const summary = { high: 0, warning: 0, info: 0 };
  for (const finding of findings ?? []) {
    if (Object.hasOwn(summary, finding.severity)) summary[finding.severity] += 1;
  }
  return summary;
}

async function toggleDiagnosticsPanel() {
  const diagnostics = state.diagnostics;
  if (!diagnostics) return;
  diagnostics.open = !diagnostics.open;
  renderDiagnostics();
  if (diagnostics.open && !diagnostics.loaded && !diagnostics.loading) {
    await loadDiagnostics(state.selectionVersion);
  }
  if (diagnostics.open && !diagnostics.alertsReport && !diagnostics.alertsLoading) {
    await loadDiagnosticAlerts(state.selectionVersion);
  }
}

function renderDiagnostics() {
  const diagnostics = state.diagnostics;
  if (!diagnostics) {
    elements["diagnostics-summary"].textContent = "等待会话";
    elements["diagnostics-toggle"].setAttribute("aria-expanded", "false");
    elements["diagnostics-panel"].hidden = true;
    return;
  }
  elements["diagnostics-toggle"].setAttribute("aria-expanded", String(diagnostics.open));
  elements["diagnostics-panel"].hidden = !diagnostics.open;
  const report = diagnostics.report;
  if (diagnostics.loading && !report) {
    elements["diagnostics-summary"].textContent = "正在分析…";
    elements["diagnostics-state"].textContent = "正在从 canonical Request projection 读取诊断事实…";
    elements["diagnostics-findings"].innerHTML = "";
    return;
  }
  if (diagnostics.error) {
    elements["diagnostics-summary"].textContent = "读取失败";
    elements["diagnostics-state"].textContent = `Diagnostics 读取失败：${diagnostics.error}`;
    elements["diagnostics-findings"].innerHTML = "";
    return;
  }
  if (!report) {
    elements["diagnostics-summary"].textContent = "正在分析…";
    elements["diagnostics-state"].textContent = "等待诊断结果…";
    elements["diagnostics-findings"].innerHTML = "";
    return;
  }
  const summary = report.summary ?? {};
  const total = Number(summary.high ?? 0) + Number(summary.warning ?? 0) + Number(summary.info ?? 0);
  elements["diagnostics-summary"].textContent = total
    ? `${summary.high ?? 0} High · ${summary.warning ?? 0} Warning · ${summary.info ?? 0} Info`
    : "未发现异常";
  elements["diagnostics-state"].textContent = `${report.policies?.local?.version ?? "local policy unknown"} + ${
    report.policies?.advanced?.version ?? "advanced policy unknown"
  } + ${report.policies?.behavioral?.version ?? "behavioral policy unknown"
  } · ${
    report.stale ? "上一完整 projection · 等待索引刷新" : "当前 projection"
  } · ${total} findings`;
  const findings = [...(report.findings ?? [])].sort(compareDiagnosticFindings);
  const groups = [
    {
      family: "local",
      title: "Local",
      description: "当前 Session 最近几次可比较 Request 的局部变化",
    },
    {
      family: "historical",
      title: "Historical",
      description: "同工程、同模型、同 effort 的长期 Robust Baseline",
    },
    {
      family: "cross_session",
      title: "Cross-session",
      description: "当前 Session slice 相对历史 Session slice 的整体退化",
    },
    {
      family: "behavioral_request",
      title: "Behavioral · Request",
      description: "同 cohort 历史下的 Reasoning token 行为异常",
    },
    {
      family: "behavioral_session",
      title: "Behavioral · Session",
      description: "Request Burst 与 Subagent Amplification 的 Session-level 异常",
    },
  ];
  elements["diagnostics-findings"].innerHTML = groups.map((group) => {
    const groupFindings = findings.filter((finding) => (finding.family ?? "local") === group.family);
    return `<section class="diagnostics-family" data-diagnostic-family="${group.family}">
      <header class="diagnostics-family-heading">
        <div><strong>${group.title}</strong><span>${group.description}</span></div>
        <code>${groupFindings.length}</code>
      </header>
      <div class="diagnostics-family-findings">${groupFindings.length
        ? groupFindings.map(renderDiagnosticFinding).join("")
        : '<div class="diagnostics-empty">当前 scope 没有该基线类型的 finding。</div>'}</div>
    </section>`;
  }).join("");
  renderDiagnosticAlerts();
}

function renderDiagnosticAlerts() {
  const diagnostics = state.diagnostics;
  const report = diagnostics?.alertsReport;
  if (!diagnostics) return;
  elements["diagnostic-alert-snooze"].disabled = diagnostics.alertsLoading || !state.selectedId;
  if (diagnostics.alertsLoading && !report) {
    elements["diagnostic-alert-summary"].textContent = "正在读取 Alerts…";
    elements["diagnostic-alerts"].innerHTML = '<div class="diagnostics-empty">正在读取本地 operational state…</div>';
    return;
  }
  if (diagnostics.alertsError) {
    elements["diagnostic-alert-summary"].textContent = "Alerts 读取失败";
    elements["diagnostic-alerts"].innerHTML = `<div class="diagnostics-empty">${escapeHtml(diagnostics.alertsError)}</div>`;
    return;
  }
  if (!report) {
    elements["diagnostic-alert-summary"].textContent = "未加载";
    elements["diagnostic-alerts"].innerHTML = '<div class="diagnostics-empty">展开 Diagnostics 后读取 Alerts。</div>';
    return;
  }
  const policy = report.policy ?? {};
  elements["diagnostic-budget-usd"].value = Number.isFinite(policy.sessionCostBudgetUsd)
    ? String(policy.sessionCostBudgetUsd)
    : "";
  elements["diagnostic-alert-severity"].value = policy.minimumSeverity === "warning" ? "warning" : "high";
  const cooldown = String(policy.cooldownMinutes ?? 60);
  if ([...elements["diagnostic-alert-cooldown"].options].some((option) => option.value === cooldown)) {
    elements["diagnostic-alert-cooldown"].value = cooldown;
  }
  const active = report.alerts ?? [];
  elements["diagnostic-alert-summary"].textContent = report.snoozed
    ? `Snoozed 至 ${formatDate(policy.snoozedUntil)} · ${report.suppressedBySnooze ?? 0} suppressed`
    : `${active.length} active · ${report.acknowledgedCount ?? 0} ack`;
  elements["diagnostic-alerts"].innerHTML = active.length
    ? active.map(renderDiagnosticAlert).join("")
    : `<div class="diagnostics-empty">${report.snoozed ? "当前处于 cooldown。" : "当前没有未确认 Alert。"}</div>`;
}

function renderDiagnosticAlert(alert) {
  const isBudget = alert.kind === "session_cost_budget";
  const title = isBudget ? "Session 等值预算超限" : diagnosticTypeLabel(alert.type);
  const metric = isBudget
    ? `${formatUsdAmount(alert.amountUsd)} / budget ${formatUsdAmount(alert.budgetUsd)} · ${formatRatio(alert.ratio)}`
    : `${alert.family === "behavioral_session" ? "Behavioral Session" : alert.family ?? "diagnostic"} · ${formatDate(alert.observedAt)}`;
  return `<article class="diagnostic-alert-item ${escapeHtml(alert.severity || "warning")}">
    <div class="diagnostic-alert-copy">
      <div><strong>${escapeHtml(title)}</strong><span class="diagnostic-severity ${escapeHtml(alert.severity || "warning")}">${escapeHtml(String(alert.severity || "warning").toUpperCase())}</span></div>
      <small>${escapeHtml(metric)}</small>
    </div>
    <div class="diagnostic-alert-controls">
      ${alert.locator?.requestId ? `<button type="button" data-diagnostic-alert-locate="${escapeHtml(alert.alertId)}">定位</button>` : ""}
      <button type="button" data-diagnostic-alert-ack="${escapeHtml(alert.alertId)}">Ack</button>
    </div>
  </article>`;
}

async function saveDiagnosticAlertPolicy() {
  if (!state.selectedId || !state.diagnostics) return;
  const rawBudget = elements["diagnostic-budget-usd"].value.trim();
  const payload = {
    sessionCostBudgetUsd: rawBudget === "" ? null : Number(rawBudget),
    minimumSeverity: elements["diagnostic-alert-severity"].value,
    cooldownMinutes: Number(elements["diagnostic-alert-cooldown"].value),
  };
  try {
    await postJson(
      `/api/sessions/${encodeURIComponent(state.selectedId)}/diagnostic-alert-policy`,
      payload,
    );
    state.diagnostics.alertsReport = null;
    toast("Alerts 策略已保存");
    await loadDiagnosticAlerts(state.selectionVersion, { force: true });
  } catch (error) {
    toast(`保存 Alerts 策略失败：${error.message}`);
  }
}

async function acknowledgeDiagnosticAlert(alertId) {
  if (!state.selectedId || !alertId || !state.diagnostics) return;
  try {
    await postJson(
      `/api/sessions/${encodeURIComponent(state.selectedId)}/diagnostic-alerts/${encodeURIComponent(alertId)}/ack`,
    );
    state.diagnostics.alertsReport = null;
    await loadDiagnosticAlerts(state.selectionVersion, { force: true });
  } catch (error) {
    toast(`Ack 失败：${error.message}`);
  }
}

async function snoozeDiagnosticAlerts() {
  if (!state.selectedId || !state.diagnostics) return;
  try {
    await postJson(`/api/sessions/${encodeURIComponent(state.selectedId)}/diagnostic-alerts/snooze`);
    state.diagnostics.alertsReport = null;
    await loadDiagnosticAlerts(state.selectionVersion, { force: true });
  } catch (error) {
    toast(`Snooze 失败：${error.message}`);
  }
}

function compareDiagnosticFindings(left, right) {
  const severityOrder = { high: 3, warning: 2, info: 1 };
  const severityDelta = (severityOrder[right.severity] ?? 0) - (severityOrder[left.severity] ?? 0);
  if (severityDelta !== 0) return severityDelta;
  return String(right.observedAt ?? "").localeCompare(String(left.observedAt ?? ""));
}

function renderDiagnosticFinding(finding) {
  const factors = diagnosticFactorLabels(finding);
  const locator = diagnosticLocator(finding);
  return `<article class="diagnostic-finding ${escapeHtml(finding.severity || "info")}">
    <div class="diagnostic-finding-main">
      <div class="diagnostic-finding-heading">
        <strong>${escapeHtml(diagnosticTypeLabel(finding.type))}</strong>
        <span class="diagnostic-severity ${escapeHtml(finding.severity || "info")}">${escapeHtml(String(finding.severity || "info").toUpperCase())}</span>
      </div>
      <div class="diagnostic-metric">${escapeHtml(diagnosticMetricText(finding))}</div>
      <div class="diagnostic-meta"><span>${formatDate(finding.observedAt ?? locator?.observedAt)}</span><code title="${escapeHtml(locator?.requestId || finding.requestId || "")}">${escapeHtml(shortId(locator?.requestId || finding.requestId || ""))}</code><span>${escapeHtml(finding.baseline?.kind || "explicit")}${finding.baseline?.sampleCount ? ` · n=${finding.baseline.sampleCount}` : ""}</span>${renderRobustBaselineMeta(finding)}</div>
      ${factors.length ? `<div class="diagnostic-factors">${factors.map((factor) => `<span>${escapeHtml(factor)}</span>`).join("")}</div>` : ""}
    </div>
    ${locator?.requestId ? `<button class="diagnostic-locate" type="button" data-diagnostic-locate="${escapeHtml(finding.findingId)}">${finding.family === "cross_session" || finding.family === "behavioral_session" ? "定位证据 Request" : "定位 Request"}</button>` : ""}
  </article>`;
}

function diagnosticLocator(finding) {
  if (finding?.locator?.requestId) return finding.locator;
  if (finding?.supportingLocator?.requestId) return finding.supportingLocator;
  if (!finding?.requestId) return null;
  return {
    ...(finding.locator ?? {}),
    requestId: finding.requestId,
    rootSessionId: finding.rootSessionId ?? null,
    threadId: finding.threadId ?? null,
    turnId: finding.turnId ?? null,
    observedAt: finding.observedAt ?? null,
  };
}

function renderRobustBaselineMeta(finding) {
  if (!["historical", "cross_session", "behavioral_request", "behavioral_session"].includes(finding.family)) return "";
  const baseline = finding.baseline ?? {};
  const parts = [];
  if (Number.isFinite(baseline.median)) parts.push(`median ${formatDiagnosticValue(finding, baseline.median)}`);
  if (Number.isFinite(baseline.mad)) parts.push(`MAD ${formatDiagnosticValue(finding, baseline.mad)}`);
  if (Number.isFinite(baseline.robustZ)) parts.push(`Z ${baseline.robustZ.toFixed(2)}`);
  return parts.length ? `<span>${escapeHtml(parts.join(" · "))}</span>` : "";
}

function diagnosticTypeLabel(type) {
  if (type === "context_inflation") return "Context Inflation";
  if (type === "cache_regression") return "Cache Regression";
  if (type === "cost_spike") return "Cost Spike";
  if (type === "long_context_trigger") return "Long Context Trigger";
  if (type === "historical_context_inflation") return "Historical Context Inflation";
  if (type === "historical_cache_regression") return "Historical Cache Regression";
  if (type === "historical_cost_spike") return "Historical Cost Spike";
  if (type === "cross_session_context_regression") return "Cross-session Context Regression";
  if (type === "cross_session_cache_regression") return "Cross-session Cache Regression";
  if (type === "cross_session_cost_regression") return "Cross-session Cost Regression";
  if (type === "reasoning_anomaly") return "Reasoning Anomaly";
  if (type === "request_burst") return "Request Burst";
  if (type === "subagent_amplification") return "Subagent Amplification";
  return type || "Usage Diagnostic";
}

function diagnosticMetricText(finding) {
  const metric = finding.metric ?? {};
  if (finding.type === "context_inflation") {
    return `${formatTokens(metric.current)} → baseline ${formatTokens(metric.baseline)} · +${formatTokens(metric.absoluteDelta)}`;
  }
  if (finding.type === "cache_regression") {
    return `${formatPercent(metric.current)} → baseline ${formatPercent(metric.baseline)} · drop ${formatPercent(finding.evidence?.drop)}`;
  }
  if (finding.type === "cost_spike") {
    return `${formatUsdAmount(metric.current)} → baseline ${formatUsdAmount(metric.baseline)} · +${formatUsdAmount(metric.absoluteDelta)}`;
  }
  if (finding.type === "long_context_trigger") {
    return `Input ${formatTokens(finding.evidence?.inputTokens)} · ${finding.evidence?.longContextStatus ?? "unknown"}`;
  }
  if (finding.type === "historical_context_inflation" || finding.type === "cross_session_context_regression") {
    return `${formatTokens(metric.current)} → historical median ${formatTokens(finding.baseline?.median)} · Δ ${signedCompact(finding.effect?.absolute)}`;
  }
  if (finding.type === "historical_cache_regression" || finding.type === "cross_session_cache_regression") {
    return `${formatPercent(metric.current)} → historical median ${formatPercent(finding.baseline?.median)} · Δ ${signedPercent(finding.effect?.percentagePoints)}`;
  }
  if (finding.type === "historical_cost_spike" || finding.type === "cross_session_cost_regression") {
    return `${formatUsdAmount(metric.current)} → historical median ${formatUsdAmount(finding.baseline?.median)} · Δ ${formatUsdAmount(finding.effect?.absolute)}`;
  }
  if (finding.type === "reasoning_anomaly") {
    return `${formatPercent(metric.current)} reasoning share → historical median ${formatPercent(finding.baseline?.median)} · Δ ${signedPercent(finding.effect?.percentagePoints)}`;
  }
  if (finding.type === "request_burst") {
    return `${Math.round(metric.current ?? 0)} Requests / 60s → historical median ${formatDiagnosticValue(finding, finding.baseline?.median)} · ${formatRatio(finding.effect?.ratio)}`;
  }
  if (finding.type === "subagent_amplification") {
    return `Descendant / Root ${formatRatio(metric.current)} → historical median ${formatRatio(finding.baseline?.median)} · extra ${signedCompact(finding.evidence?.descendantExtraTokens)} tokens`;
  }
  return String(metric.current ?? "—");
}

function formatDiagnosticValue(finding, value) {
  if (finding.type?.includes("cache")) return formatPercent(value);
  if (finding.type?.includes("cost")) return formatUsdAmount(value);
  if (finding.type === "reasoning_anomaly") return formatPercent(value);
  if (finding.type === "request_burst") return Number.isFinite(value) ? `${Number(value).toFixed(1)} req` : "—";
  if (finding.type === "subagent_amplification") return formatRatio(value);
  return formatTokens(value);
}

function diagnosticFactorLabels(finding) {
  const evidence = finding.evidence ?? {};
  const factors = [];
  if (finding.type === "cache_regression" && evidence.breakpointCandidate) factors.push("cache breakpoint candidate");
  if (Number.isFinite(evidence.inputDelta)) factors.push(`Input Δ ${signedCompact(evidence.inputDelta)}`);
  if (Number.isFinite(evidence.cacheHitDelta)) factors.push(`Cache Δ ${signedPercent(evidence.cacheHitDelta)}`);
  if (evidence.longContextStatus && evidence.longContextStatus !== "normal") factors.push(`Long ${evidence.longContextStatus}`);
  if (evidence.serviceTier) factors.push(`Tier ${evidence.serviceTier}`);
  if (evidence.pricingStatus) factors.push(`Pricing ${evidence.pricingStatus}`);
  if (finding.type === "reasoning_anomaly") {
    if (Number.isFinite(evidence.reasoningOutputTokens)) factors.push(`Reasoning ${formatTokens(evidence.reasoningOutputTokens)}`);
    if (Number.isFinite(evidence.outputTokens)) factors.push(`Output ${formatTokens(evidence.outputTokens)}`);
  }
  if (finding.type === "request_burst") {
    if (Number.isFinite(evidence.requestCount)) factors.push(`${evidence.requestCount} Requests / 60s`);
    if (evidence.episodeStart && evidence.episodeEnd) factors.push("120s idle-gap episode");
  }
  if (finding.type === "subagent_amplification") {
    if (Number.isFinite(evidence.descendantRequests)) factors.push(`${evidence.descendantRequests} descendant Requests`);
    if (Number.isFinite(evidence.descendantAgents)) factors.push(`${evidence.descendantAgents} descendant agents`);
    if (Number.isFinite(evidence.maxDepth)) factors.push(`depth ${evidence.maxDepth}`);
  }
  return factors;
}

function groupDiagnosticsByRequest(findings) {
  const grouped = new Map();
  for (const finding of findings ?? []) {
    if (!finding?.requestId) continue;
    const current = grouped.get(finding.requestId) ?? [];
    current.push(finding);
    grouped.set(finding.requestId, current);
  }
  return grouped;
}

function refreshOpenRequestDiagnosticMarkers() {
  for (const detail of state.requestDetails.values()) {
    if (detail.open) patchVisibleTaskDetail(detail.threadId, detail.turnId);
  }
}

async function locateDiagnosticRequest(finding) {
  const locator = diagnosticLocator(finding);
  const threadId = locator?.threadId ?? finding.threadId;
  const turnId = locator?.turnId ?? finding.turnId;
  const requestId = locator?.requestId ?? finding.requestId;
  const task = currentTask(threadId, turnId);
  if (!task) {
    toast("当前 scope 中找不到该 finding 对应的 Task");
    return;
  }
  expandDiagnosticTaskContainer(threadId, turnId);
  await toggleTaskRequests(threadId, turnId, { forceOpen: true });
  const detail = requestDetailState(threadId, turnId);
  if (!detail?.open) {
    toast("Canonical Requests 无法展开");
    return;
  }
  const ordinal = Number(locator?.requestOrdinalInScope);
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    toast("该 finding 缺少可用的 Request ordinal");
    return;
  }
  const pageSize = REQUEST_PAGE_SIZE_OPTIONS.includes(Number(detail.pageSize))
    ? Number(detail.pageSize)
    : REQUEST_PAGE_SIZE;
  const targetPage = Math.ceil(ordinal / pageSize);
  if (!detail.loaded || detail.page !== targetPage) {
    await setRequestPage(threadId, turnId, targetPage);
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const row = [...elements["agent-tree"].querySelectorAll("tr[data-request-id]")]
    .find((candidate) => candidate.dataset.requestId === requestId);
  if (!row) {
    toast("已打开目标 Request 页，但未找到对应 canonical request_id");
    return;
  }
  state.highlightedRequestId = requestId;
  for (const candidate of elements["agent-tree"].querySelectorAll("tr.diagnostic-target")) {
    candidate.classList.remove("diagnostic-target");
  }
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  row.classList.add("diagnostic-target");
  row.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center", inline: "nearest" });
}

function expandDiagnosticTaskContainer(threadId, turnId) {
  const row = [...elements["agent-tree"].querySelectorAll("tr[data-task-id][data-thread-id]")]
    .find((candidate) => candidate.dataset.taskId === turnId && candidate.dataset.threadId === threadId);
  const agentCard = row?.closest(".agent-card");
  if (agentCard && !agentCard.open) agentCard.open = true;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function formatRatio(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)}×` : "—";
}

function signedPercent(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
}

function signedCompact(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${compactFormatter.format(value)}`;
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
  structuralChanged = patchAgentTasks(details, agent) || structuralChanged;
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
  return `${renderTaskTableShell(agent.tasks.map(renderTaskRow).join(""))}<div class="task-request-details" aria-live="polite"></div>`;
}

function renderPageButtons(kind, page, totalPages, contextAttributes) {
  const actionAttribute = `data-${kind}-page-action`;
  const pageAttribute = `data-${kind}-page-number`;
  const items = paginationItems(page, totalPages);
  const numbered = items.map((candidate) => {
    if (typeof candidate !== "number") return '<span class="page-ellipsis" aria-hidden="true">…</span>';
    return `<button class="page-number${candidate === page ? " active" : ""}" type="button" ${pageAttribute}="${candidate}" ${contextAttributes} aria-current="${candidate === page ? "page" : "false"}">${candidate}</button>`;
  }).join("");
  return `<div class="page-controls">
    <button class="page-edge" type="button" ${actionAttribute}="prev" ${contextAttributes} ${page <= 1 ? "disabled" : ""} aria-label="上一页"><i class="page-nav-icon" data-lucide="chevron-left" aria-hidden="true">‹</i></button>
    <span class="page-numbers">${numbered}</span>
    <button class="page-edge" type="button" ${actionAttribute}="next" ${contextAttributes} ${page >= totalPages ? "disabled" : ""} aria-label="下一页"><i class="page-nav-icon" data-lucide="chevron-right" aria-hidden="true">›</i></button>
  </div>`;
}

function paginationItems(page, totalPages) {
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (page <= 3) return [1, 2, 3, "ellipsis", totalPages];
  if (page >= totalPages - 2) return [1, "ellipsis", totalPages - 2, totalPages - 1, totalPages];
  return [1, "ellipsis-left", page, "ellipsis-right", totalPages];
}

function pageFromAction(action, currentPage, totalPages) {
  if (action === "first") return 1;
  if (action === "prev") return Math.max(1, currentPage - 1);
  if (action === "next") return Math.min(totalPages, currentPage + 1);
  if (action === "last") return totalPages;
  return currentPage;
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
  return `<div class="task-table-wrap" data-scope-kind="${dayScope ? "day" : "session"}" role="region" tabindex="0" aria-label="${dayScope ? "当日任务活动" : "任务记录"}；任务与状态列固定，可横向滚动查看完整 ${columnCount} 列">
    ${dayScope ? "" : '<div class="task-table-heading" aria-hidden="true">任务记录</div>'}
    <table class="task-table ${dayScope ? "day-scope" : "session-scope"}">
    <caption class="visually-hidden">${dayScope ? "当日任务活动" : "任务记录"}</caption>
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
  const taskCell = `<td class="task-name-cell"><button class="task-request-toggle" type="button" data-task-toggle data-thread-id="${escapeHtml(task.threadId)}" data-turn-id="${escapeHtml(task.turnId)}" aria-expanded="${detail?.open ? "true" : "false"}" aria-label="${detail?.open ? "收起" : "展开"} Task ${task.sequence} 的 Canonical Requests"><strong>Task ${task.sequence}</strong><code title="${escapeHtml(task.turnId)}">${escapeHtml(shortId(task.turnId))}</code><span class="request-count-pill">${task.requestCount ?? 0} Requests</span></button></td>`;
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

function patchAgentTasks(details, agent) {
  if (!details) return false;
  const tasks = agent.tasks ?? [];
  let structuralChanged = false;
  let tableWrap = directChildByClass(details, "task-table-wrap");
  let requestDetailsHost = directChildByClass(details, "task-request-details");
  let empty = directChildByClass(details, "empty-agent");
  if (!tasks.length) {
    if (tableWrap) {
      tableWrap.remove();
      structuralChanged = true;
    }
    if (requestDetailsHost) {
      requestDetailsHost.remove();
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
  structuralChanged = patchTaskRows(tableWrap, tasks) || structuralChanged;
  if (!requestDetailsHost) {
    requestDetailsHost = document.createElement("div");
    requestDetailsHost.className = "task-request-details";
    requestDetailsHost.setAttribute("aria-live", "polite");
    details.append(requestDetailsHost);
    structuralChanged = true;
  }
  structuralChanged = patchTaskRequestDetails(requestDetailsHost, tasks) || structuralChanged;
  return structuralChanged;
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
    insertionPoint = row.nextElementSibling;
  });

  for (const [taskId, row] of existing) {
    if (!desiredIds.has(taskId)) {
      row.remove();
      structuralChanged = true;
    }
  }
  return structuralChanged;
}

function patchTaskRequestDetails(host, tasks) {
  const existing = new Map(
    [...host.querySelectorAll(":scope > .task-request-row")].map((detail) => [detail.dataset.taskDetailId, detail]),
  );
  const desiredIds = new Set(tasks.map((task) => task.turnId));
  let structuralChanged = false;
  let insertionPoint = host.firstElementChild;
  for (const task of tasks) {
    const detailState = requestDetailState(task.threadId, task.turnId);
    const current = existing.get(task.turnId);
    if (!detailState && !current) continue;
    const detail = patchTaskRequestDetail(host, task);
    if (detail && insertionPoint !== detail) {
      host.insertBefore(detail, insertionPoint);
      structuralChanged = true;
    }
    insertionPoint = detail?.nextElementSibling ?? insertionPoint;
  }
  for (const [taskId, detail] of existing) {
    if (!desiredIds.has(taskId)) {
      detail.remove();
      structuralChanged = true;
    }
  }
  return structuralChanged;
}

function patchTaskRequestDetail(host, task) {
  const detail = requestDetailState(task.threadId, task.turnId);
  let detailRow = findTaskDetailRow(host, task.turnId);
  if (!detail && !detailRow) return null;
  const created = !detailRow;
  if (!detailRow) {
    detailRow = document.createElement("div");
    detailRow.className = "task-request-row task-request-drawer";
    detailRow.dataset.taskDetailId = task.turnId;
    detailRow.dataset.open = "false";
    host.append(detailRow);
  }
  const signature = requestDetailRenderSignature(detail, task);
  if (detailRow.dataset.contentSignature !== signature) {
    detailRow.innerHTML = `<div class="task-request-panel" aria-hidden="${detail?.open ? "false" : "true"}" ${detail?.open ? "" : "inert"}><div class="task-request-panel-clip">${renderRequestDetail(detail, task)}</div></div>`;
    refreshLucideIcons();
    detailRow.dataset.contentSignature = signature;
  } else {
    const panel = detailRow.querySelector(":scope > .task-request-panel");
    if (panel) {
      panel.setAttribute("aria-hidden", detail?.open ? "false" : "true");
      panel.toggleAttribute("inert", !detail?.open);
    }
  }
  if (created && detail?.open) {
    requestAnimationFrame(() => {
      if (detailRow.isConnected && requestDetailState(task.threadId, task.turnId)?.open) {
        detailRow.dataset.open = "true";
      }
    });
  } else {
    detailRow.dataset.open = detail?.open ? "true" : "false";
  }
  return detailRow;
}

function requestDetailRenderSignature(detail, task) {
  if (!detail) return "closed";
  const requestIds = detail.requests?.map((request) => request.requestId).join(",") ?? "";
  const pagination = detail.pagination;
  return [
    detail.loading ? "loading" : "idle",
    detail.loaded ? "loaded" : "unloaded",
    detail.error ?? "",
    detail.page ?? 1,
    pagination?.totalItems ?? "",
    pagination?.totalPages ?? "",
    detail.projectionGeneration ?? "",
    state.diagnostics?.renderVersion ?? 0,
    task?.effort ?? "",
    requestIds,
  ].join("|");
}

function findTaskDetailRow(host, turnId) {
  return [...host.querySelectorAll(":scope > .task-request-row")]
    .find((row) => row.dataset.taskDetailId === turnId) ?? null;
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

async function toggleTaskRequests(threadId, turnId, { forceOpen = null } = {}) {
  const task = currentTask(threadId, turnId);
  if (!task) return;
  const key = requestDetailKey(threadId, turnId);
  const existing = state.requestDetails.get(key);
  if (existing) {
    const nextOpen = forceOpen == null ? !existing.open : Boolean(forceOpen);
    if (nextOpen) collapseOtherRequestDetails(key);
    existing.open = nextOpen;
    patchVisibleTaskDetail(threadId, turnId);
    if (existing.open && !existing.loaded && !existing.loading) {
      await loadTaskRequests(threadId, turnId);
    }
    return;
  }
  collapseOtherRequestDetails(key);
  state.requestDetails.set(key, {
    threadId,
    turnId,
    open: true,
    loaded: false,
    loading: false,
    requests: [],
    page: 1,
    pageSize: REQUEST_PAGE_SIZE,
    pagination: null,
    projectionGeneration: null,
    error: null,
  });
  patchVisibleTaskDetail(threadId, turnId);
  await loadTaskRequests(threadId, turnId);
}

function collapseOtherRequestDetails(activeKey) {
  for (const [key, detail] of state.requestDetails) {
    if (key === activeKey || !detail.open) continue;
    detail.open = false;
    patchVisibleTaskDetail(detail.threadId, detail.turnId);
  }
}

async function loadTaskRequests(threadId, turnId, { page = null } = {}) {
  const key = requestDetailKey(threadId, turnId);
  const detail = state.requestDetails.get(key);
  if (!detail || detail.loading || !detail.open) return;
  const selectionVersion = state.selectionVersion;
  const requestedPage = Math.max(1, Number(page ?? detail.page ?? 1) || 1);
  const pageSize = REQUEST_PAGE_SIZE_OPTIONS.includes(Number(detail.pageSize))
    ? Number(detail.pageSize)
    : REQUEST_PAGE_SIZE;
  detail.loading = true;
  detail.error = null;
  patchVisibleTaskDetail(threadId, turnId);
  try {
    const query = new URLSearchParams({ limit: String(pageSize), page: String(requestedPage) });
    if (state.selectedDay) query.set("day", state.selectedDay);
    const payload = await fetchJson(
      `/api/sessions/${encodeURIComponent(state.selectedId)}/tasks/${encodeURIComponent(threadId)}/${encodeURIComponent(turnId)}/requests?${query}`,
    );
    if (selectionVersion !== state.selectionVersion || state.requestDetails.get(key) !== detail) return;
    detail.requests = payload.requests;
    detail.pagination = payload.pagination ?? {
      page: requestedPage,
      pageSize,
      totalItems: payload.requests.length,
      totalPages: payload.requests.length ? 1 : 0,
    };
    detail.pageSize = detail.pagination.pageSize ?? pageSize;
    detail.page = detail.pagination.totalPages > 0
      ? clamp(detail.pagination.page, 1, detail.pagination.totalPages)
      : 1;
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
  const task = currentTask(threadId, turnId);
  row.innerHTML = renderTaskCells(task);
  const host = directChildByClass(row.closest(".agent-card"), "task-request-details");
  if (host) patchTaskRequestDetail(host, task);
}

async function refreshStaleOpenRequestDetails() {
  const generation = Number(state.snapshot?.health?.projectionGeneration ?? 0);
  const jobs = [];
  for (const detail of state.requestDetails.values()) {
    if (!detail.open || !detail.loaded || detail.loading || detail.projectionGeneration === generation) continue;
    detail.loaded = false;
    detail.page = 1;
    detail.pagination = null;
    jobs.push(loadTaskRequests(detail.threadId, detail.turnId));
  }
  await Promise.all(jobs);
}

function renderRequestDetail(detail, task) {
  const totalItems = detail?.pagination?.totalItems ?? task?.requestCount ?? detail?.requests?.length ?? 0;
  let content;
  if (detail?.error) {
    content = `<div class="request-detail-state error">Request 明细读取失败：${escapeHtml(detail.error)}</div>`;
  } else if (!detail?.loaded && detail?.loading) {
    content = '<div class="request-detail-state">正在读取 canonical Requests…</div>';
  } else if (!detail?.requests?.length) {
    content = '<div class="request-detail-state">这个 Task 没有可展示的 canonical Request。</div>';
  } else {
    content = `<div class="request-audit-scroll" role="region" tabindex="0" aria-label="Canonical Requests 表格，可独立横向滚动"><table class="request-table">
      <thead><tr><th>时间</th><th>Input</th><th>Cached</th><th title="Cached / Input">Cache Hit Rate</th><th>Cache Write</th><th>Output</th><th>Reasoning</th><th>Total</th><th>Model</th><th>推理强度</th><th title="只有 service_tier 明确为 fast 才使用 Fast 定价；default、standard、priority、缺失或其他值一律按 standard 计费。">服务层级</th><th>USD</th><th>诊断</th><th>详情</th></tr></thead>
      <tbody>${detail.requests.map((request) => renderRequestRow(request, task?.effort)).join("")}</tbody>
    </table></div>
    ${renderRequestPagination(detail)}`;
  }
  return `<div class="request-audit-shell"><div class="request-audit">
    <div class="request-audit-toolbar"><button class="request-collapse-handle" type="button" data-request-collapse data-thread-id="${escapeHtml(detail?.threadId ?? task?.threadId ?? "")}" data-turn-id="${escapeHtml(detail?.turnId ?? task?.turnId ?? "")}" aria-label="收起 Canonical Requests" title="收起 Canonical Requests"><span class="request-grip-lines" aria-hidden="true"></span></button></div>
    <div class="request-audit-heading"><strong>Canonical Requests</strong><span>${tokenFormatter.format(totalItems)} Requests</span></div>
    ${content}
  </div></div>`;
}

function renderRequestPagination(detail) {
  const pagination = detail.pagination;
  if (!pagination || pagination.totalPages <= 0 || pagination.totalItems < REQUEST_PAGE_SIZE) return "";
  const page = clamp(detail.page ?? pagination.page ?? 1, 1, pagination.totalPages);
  const pageSize = REQUEST_PAGE_SIZE_OPTIONS.includes(Number(detail.pageSize))
    ? Number(detail.pageSize)
    : REQUEST_PAGE_SIZE;
  const context = `data-thread-id="${escapeHtml(detail.threadId)}" data-turn-id="${escapeHtml(detail.turnId)}"`;
  const hasMultiplePages = pagination.totalPages > 1;
  return `<nav class="request-pagination pagination-bar" aria-label="Canonical Requests 分页">
    <div class="page-size-control" role="group" aria-label="每页 Request 数量">
      <span>每页</span>
      ${REQUEST_PAGE_SIZE_OPTIONS.map((size) => `<button class="page-size-option${size === pageSize ? " active" : ""}" type="button" data-request-page-size="${size}" ${context} aria-pressed="${size === pageSize ? "true" : "false"}">${size}</button>`).join("")}
    </div>
    ${hasMultiplePages ? `${renderPageButtons("request", page, pagination.totalPages, context)}
      <span class="request-page-summary page-summary">第 ${page} / ${pagination.totalPages} 页 · 共 ${pagination.totalItems} Requests</span>
      <label class="page-jump"><span>跳转</span><input type="text" value="${page}" inputmode="numeric" pattern="[0-9]*" maxlength="${String(pagination.totalPages).length}" data-request-page-jump ${context} aria-label="跳转到 Request 页码"><span>页</span></label>
      <button class="page-jump-submit" type="button" data-request-page-jump-submit ${context}>前往</button>` : `<span class="request-page-summary page-summary">共 ${pagination.totalItems} Requests</span>`}
  </nav>`;
}

async function setRequestPageSize(threadId, turnId, requestedPageSize) {
  const detail = requestDetailState(threadId, turnId);
  if (!detail?.open || !detail.pagination || !REQUEST_PAGE_SIZE_OPTIONS.includes(requestedPageSize)) return;
  if (detail.pageSize === requestedPageSize && detail.loaded) return;
  detail.pageSize = requestedPageSize;
  detail.page = 1;
  detail.loaded = false;
  await loadTaskRequests(threadId, turnId, { page: 1 });
}

async function handleRequestPageAction(control) {
  const threadId = control.dataset.threadId;
  const turnId = control.dataset.turnId;
  const detail = requestDetailState(threadId, turnId);
  if (!detail?.open || !detail.pagination) return;
  let page = detail.page ?? 1;
  if (control.dataset.requestPageNumber) page = Number(control.dataset.requestPageNumber);
  else if (control.matches("[data-request-page-jump-submit]")) {
    const input = control.closest(".request-pagination")?.querySelector("[data-request-page-jump]");
    if (input) page = Number(input.value);
  } else {
    page = pageFromAction(control.dataset.requestPageAction, page, detail.pagination.totalPages);
  }
  await setRequestPage(threadId, turnId, page);
}

async function jumpRequestPageFromInput(input) {
  await setRequestPage(input.dataset.threadId, input.dataset.turnId, Number(input.value));
}

async function setRequestPage(threadId, turnId, requestedPage) {
  const detail = requestDetailState(threadId, turnId);
  if (!detail?.open || !detail.pagination) return;
  const totalPages = Math.max(1, detail.pagination.totalPages);
  const page = clamp(Number.isInteger(requestedPage) ? requestedPage : 1, 1, totalPages);
  if (page === detail.page && detail.loaded) return;
  detail.page = page;
  detail.loaded = false;
  await loadTaskRequests(threadId, turnId, { page });
}

function renderRequestRow(request, effort) {
  const highlighted = request.requestId && request.requestId === state.highlightedRequestId;
  return `<tr data-request-id="${escapeHtml(request.requestId || "")}"${highlighted ? ' class="diagnostic-target"' : ""}>
    <td title="${escapeHtml(request.observedAt || "")}">${formatDate(request.observedAt)}</td>
    <td>${formatTokens(request.usage?.inputTokens)}</td>
    <td>${formatTokens(request.usage?.cachedInputTokens)}</td>
    <td class="request-cache-hit">${formatRequestCacheHitRate(request.usage)}</td>
    <td>${formatTokens(request.usage?.cacheWriteInputTokens)}</td>
    <td>${formatTokens(request.usage?.outputTokens)}</td>
    <td>${formatTokens(request.usage?.reasoningOutputTokens)}</td>
    <td><strong>${formatTokens(request.usage?.totalTokens)}</strong></td>
    <td><code class="request-model" title="${escapeHtml(request.model || "模型未知")}">${escapeHtml(request.model || "未知")}</code></td>
    <td><span class="effort-chip">${escapeHtml(effortLabel(effort))}</span></td>
    <td><span class="tier-chip ${serviceTierClass(request.serviceTier)}">${escapeHtml(serviceTierLabel(request.serviceTier, request.costEstimate))}</span></td>
    <td class="request-cost ${escapeHtml(request.costEstimate?.status || "unavailable")}" title="${escapeHtml(requestCostEstimateTitle(request.costEstimate))}">${formatUsdEstimate(request.costEstimate)}</td>
    <td class="request-diagnostic-cell">${renderRequestDiagnosticMarker(request.requestId)}</td>
    <td class="request-inspect-cell"><button class="request-inspect-button" type="button" data-request-inspect="${escapeHtml(request.requestId || "")}" aria-label="查看 Request ${escapeHtml(shortId(request.requestId))} 的交互内容">查看</button></td>
  </tr>`;
}

function formatRequestCacheHitRate(usage) {
  const inputTokens = Number(usage?.inputTokens);
  const cachedInputTokens = Number(usage?.cachedInputTokens);
  if (!Number.isFinite(inputTokens) || inputTokens <= 0 || !Number.isFinite(cachedInputTokens) || cachedInputTokens < 0) {
    return "—";
  }
  return formatPercent(Math.min(cachedInputTokens, inputTokens) / inputTokens);
}

function renderRequestDiagnosticMarker(requestId) {
  const findings = state.diagnostics?.requestFindings?.get(requestId) ?? [];
  if (!findings.length) return '<span class="request-diagnostic-none">—</span>';
  const severityOrder = { high: 3, warning: 2, info: 1 };
  const highest = findings.reduce((selected, finding) =>
    (severityOrder[finding.severity] ?? 0) > (severityOrder[selected?.severity] ?? 0) ? finding : selected
  , null);
  const severity = highest?.severity ?? "info";
  const title = findings.map((finding) => diagnosticTypeLabel(finding.type)).join(" · ");
  return `<span class="request-diagnostic-marker ${escapeHtml(severity)}" title="${escapeHtml(title)}">${findings.length}</span>`;
}

async function openRequestInspector(trigger) {
  const requestId = trigger?.dataset?.requestInspect;
  const sessionId = state.selectedId;
  if (!requestId || !sessionId) return;
  const inspector = state.requestInspector;
  inspector.abortController?.abort();
  const selectionVersion = ++inspector.selectionVersion;
  inspector.open = true;
  inspector.requestId = requestId;
  inspector.loading = true;
  inspector.error = null;
  inspector.payload = null;
  inspector.activeTab = "interaction";
  inspector.inputContext.abortController?.abort();
  inspector.inputContext = { loading: false, error: null, payload: null, abortController: null };
  inspector.stale = false;
  inspector.projectionGeneration = null;
  inspector.trigger = trigger;
  inspector.restoreFocusOnClose = true;
  inspector.abortController = new AbortController();
  renderRequestInspector();
  if (!elements["request-inspector"].open) elements["request-inspector"].showModal();
  try {
    const payload = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}/content`,
      { signal: inspector.abortController.signal },
    );
    if (
      selectionVersion !== inspector.selectionVersion ||
      requestId !== inspector.requestId ||
      sessionId !== state.selectedId
    ) return;
    inspector.payload = payload;
    inspector.projectionGeneration = payload.projectionGeneration ?? null;
    inspector.loading = false;
    inspector.error = null;
    renderRequestInspector();
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (selectionVersion !== inspector.selectionVersion || requestId !== inspector.requestId) return;
    inspector.loading = false;
    inspector.error = error.message;
    renderRequestInspector();
  } finally {
    if (selectionVersion === inspector.selectionVersion) inspector.abortController = null;
  }
}

async function loadRequestInputContext({ force = false } = {}) {
  const inspector = state.requestInspector;
  const requestId = inspector.requestId;
  const sessionId = state.selectedId;
  if (!inspector.open || !requestId || !sessionId) return;
  if (inspector.inputContext.payload && !force) return;
  inspector.inputContext.abortController?.abort();
  const selectionVersion = inspector.selectionVersion;
  const controller = new AbortController();
  inspector.inputContext = {
    loading: true,
    error: null,
    payload: force ? null : inspector.inputContext.payload,
    abortController: controller,
  };
  renderRequestInspector();
  try {
    const payload = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}/input-context`,
      { signal: controller.signal },
    );
    if (
      selectionVersion !== inspector.selectionVersion ||
      requestId !== inspector.requestId ||
      sessionId !== state.selectedId
    ) return;
    inspector.inputContext = { loading: false, error: null, payload, abortController: null };
    inspector.projectionGeneration = payload.projectionGeneration ?? inspector.projectionGeneration;
    inspector.stale = false;
    renderRequestInspector();
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (selectionVersion !== inspector.selectionVersion || requestId !== inspector.requestId) return;
    inspector.inputContext = { loading: false, error: error.message, payload: null, abortController: null };
    renderRequestInspector();
  }
}

async function refreshRequestInspector() {
  const inspector = state.requestInspector;
  if (!inspector.open || !inspector.requestId || !state.selectedId) return;
  const trigger = inspector.trigger ?? findRequestInspectorTrigger(inspector.requestId);
  if (!trigger) return;
  await openRequestInspector(trigger);
}

function closeRequestInspector({ restoreFocus = true } = {}) {
  const dialog = elements["request-inspector"];
  state.requestInspector.restoreFocusOnClose = restoreFocus;
  state.requestInspector.abortController?.abort();
  state.requestInspector.abortController = null;
  if (dialog.open) dialog.close();
  else releaseRequestInspectorContent();
}

function releaseRequestInspectorContent() {
  const inspector = state.requestInspector;
  const requestId = inspector.requestId;
  const trigger = inspector.trigger;
  const restoreFocus = inspector.restoreFocusOnClose;
  inspector.selectionVersion += 1;
  inspector.abortController?.abort();
  inspector.inputContext.abortController?.abort();
  inspector.open = false;
  inspector.requestId = null;
  inspector.loading = false;
  inspector.error = null;
  inspector.payload = null;
  inspector.activeTab = "interaction";
  inspector.inputContext = { loading: false, error: null, payload: null, abortController: null };
  inspector.stale = false;
  inspector.projectionGeneration = null;
  inspector.abortController = null;
  inspector.trigger = null;
  inspector.restoreFocusOnClose = true;
  elements["request-inspector-body"].replaceChildren();
  if (!restoreFocus) return;
  const focusTarget = trigger?.isConnected ? trigger : findRequestInspectorTrigger(requestId);
  if (focusTarget) queueMicrotask(() => focusTarget.focus({ preventScroll: true }));
}

function findRequestInspectorTrigger(requestId) {
  if (!requestId) return null;
  return [...elements["agent-tree"].querySelectorAll("[data-request-inspect]")]
    .find((candidate) => candidate.dataset.requestInspect === requestId) ?? null;
}

function markRequestInspectorStaleIfNeeded() {
  const inspector = state.requestInspector;
  if (!inspector.open || !inspector.payload || inspector.projectionGeneration == null) return;
  const currentGeneration = Number(state.snapshot?.health?.projectionGeneration ?? 0);
  if (!Number.isFinite(currentGeneration) || currentGeneration === Number(inspector.projectionGeneration)) return;
  inspector.stale = true;
  renderRequestInspector();
}

function renderRequestInspector() {
  const inspector = state.requestInspector;
  const request = inspector.payload?.request ?? null;
  elements["request-inspector-title"].textContent = request?.requestId
    ? `Request ${shortId(request.requestId)}`
    : inspector.requestId
      ? `Request ${shortId(inspector.requestId)}`
      : "Request Inspector";
  elements["request-inspector-evidence"].textContent = inspector.activeTab === "input_context"
    ? "Reconstructed Input Context · Provider payload / serialization unavailable"
    : "Rollout observed interaction · Provider Payload unavailable / not reconstructed";
  if (inspector.loading) {
    elements["request-inspector-body"].innerHTML = `
      <div class="request-inspector-state" role="status">
        <strong>正在读取本地 rollout…</strong>
        <span>只读取当前 Request 的 bounded interaction slice，不重放 Session。</span>
      </div>`;
    return;
  }
  if (inspector.error) {
    elements["request-inspector-body"].innerHTML = `
      <div class="request-inspector-state error">
        <strong>Request 内容读取失败</strong>
        <span>${escapeHtml(inspector.error)}</span>
        <button type="button" data-request-inspector-refresh>重新读取</button>
      </div>`;
    return;
  }
  const payload = inspector.payload;
  if (!payload) {
    elements["request-inspector-body"].replaceChildren();
    return;
  }
  const stale = inspector.stale
    ? `<div class="request-inspector-stale"><span>Canonical projection 已更新；当前内容仍保持打开时的只读快照。</span><button type="button" data-request-inspector-refresh>重新读取</button></div>`
    : "";
  const tabs = renderRequestInspectorTabs(inspector.activeTab);
  const availability = inspector.activeTab === "input_context"
    ? renderRequestInputContextTab(inspector.inputContext)
    : payload.available
      ? renderRequestInspectorSemanticSections(payload)
      : renderRequestInspectorUnavailable(payload);
  elements["request-inspector-body"].innerHTML = `
    ${stale}
    ${renderRequestInspectorSummary(payload.request, payload.evidence)}
    ${tabs}
    ${availability}
    ${inspector.activeTab === "interaction" ? renderRequestInspectorEvidence(payload.evidence, payload.summary) : ""}`;
}

function renderRequestInspectorTabs(activeTab) {
  return `<div class="request-inspector-tabs" role="tablist" aria-label="Request Inspector 视图">
    <button type="button" role="tab" aria-selected="${activeTab === "interaction"}" class="${activeTab === "interaction" ? "active" : ""}" data-request-inspector-tab="interaction">Interaction</button>
    <button type="button" role="tab" aria-selected="${activeTab === "input_context"}" class="${activeTab === "input_context" ? "active" : ""}" data-request-inspector-tab="input_context">Input Context</button>
  </div>`;
}

function renderRequestInspectorSummary(request, evidence) {
  const usage = request?.usage ?? {};
  return `<section class="request-inspector-summary" aria-label="Request 摘要">
    <div class="request-inspector-meta">
      <span><small>时间</small><strong>${escapeHtml(formatDate(request?.observedAt))}</strong></span>
      <span><small>Model</small><strong>${escapeHtml(request?.model || "未知")}</strong></span>
      <span><small>Effort</small><strong>${escapeHtml(effortLabel(request?.effort))}</strong></span>
      <span><small>Tier</small><strong>${escapeHtml(serviceTierLabel(request?.serviceTier, request?.costEstimate))}</strong></span>
    </div>
    <div class="request-inspector-usage">
      <span><small>Input Tokens</small><strong>${formatTokens(usage.inputTokens)}</strong></span>
      <span><small>Cached Input Tokens</small><strong>${formatTokens(usage.cachedInputTokens)}</strong></span>
      <span><small>Cache Hit Rate</small><strong>${formatRequestCacheHitRate(usage)}</strong></span>
      <span><small>Output Tokens</small><strong>${formatTokens(usage.outputTokens)}</strong></span>
      <span><small>Total Tokens</small><strong>${formatTokens(usage.totalTokens)}</strong></span>
      <span><small>USD</small><strong>${formatUsdEstimate(request?.costEstimate)}</strong></span>
    </div>
    <p class="request-inspector-accounting-note">Token 指标表示本次 Request 的计量规模；下方只展示 rollout 中直接可观察的输入/交互证据，不等于完整 Provider Input。</p>
    <p class="request-inspector-proof"><strong>Evidence</strong><span>${escapeHtml(requestEvidenceLabel(evidence))}</span></p>
  </section>`;
}

function renderRequestInspectorSemanticSections(payload) {
  const items = payload.items ?? [];
  const observedInput = items.filter((item) => item.section === "observed_input");
  const runtimeContext = items.filter((item) => item.section === "runtime_context");
  const interaction = items.filter((item) => item.section === "observed_interaction");
  const truncated = payload.evidence?.truncated
    ? '<p class="request-inspector-warning">当前 interaction 已达到读取/正文上限，以下内容为显式截断结果。</p>'
    : "";
  const inputContent = observedInput.length
    ? observedInput.map(renderRequestContentItem).join("")
    : '<div class="request-inspector-state compact"><strong>没有可直接展示的 pre-model input</strong><span>完整输入可能来自历史上下文，或来自未在当前 slice 中逐项记录的 provider/harness context。</span></div>';
  const interactionContent = interaction.length
    ? interaction.map(renderRequestContentItem).join("")
    : '<div class="request-inspector-state compact"><strong>没有可展示的交互正文</strong><span>该 slice 可能只包含计量、生命周期或 runtime metadata。</span></div>';
  const cutLabel = payload.preModelCut?.status === "observed"
    ? `Local evidence cut before first observed model output · line ${payload.preModelCut.lineNumber ?? "—"}`
    : "Pre-model evidence cut unavailable · current slice is not treated as complete input";
  return `${truncated}
    <section class="request-interaction request-observed-input" aria-labelledby="request-input-title">
      <header><div><p class="eyebrow">OBSERVED INPUT EVIDENCE</p><h3 id="request-input-title">本轮可观察输入证据</h3></div><span>${tokenFormatter.format(observedInput.length)} items</span></header>
      <p class="request-section-note">${escapeHtml(cutLabel)}。这是本地记录顺序证据，不是 Provider request start。</p>
      <div class="request-interaction-list">${inputContent}</div>
    </section>
    ${renderRuntimeContextSection(runtimeContext)}
    <section class="request-interaction" aria-labelledby="request-interaction-title">
    <header><div><p class="eyebrow">OBSERVED INTERACTION</p><h3 id="request-interaction-title">本次可观察交互</h3></div><span>${tokenFormatter.format(payload.summary?.observedItemCount ?? items.length)} items</span></header>
    <div class="request-interaction-list">${interactionContent}</div>
  </section>`;
}

function renderRequestInputContextTab(inputContext) {
  if (inputContext.loading) {
    return `<section class="request-interaction">
      <div class="request-inspector-state" role="status">
        <strong>正在重建输入上下文…</strong>
        <span>只在当前 tab 主动读取 bounded 同线程历史，不进入 Session snapshot 或 SSE。</span>
      </div>
    </section>`;
  }
  if (inputContext.error) {
    return `<section class="request-interaction">
      <div class="request-inspector-state error">
        <strong>Input Context 读取失败</strong>
        <span>${escapeHtml(inputContext.error)}</span>
        <button type="button" data-request-inspector-refresh>重新读取</button>
      </div>
    </section>`;
  }
  const payload = inputContext.payload;
  if (!payload) {
    return `<section class="request-interaction">
      <div class="request-inspector-state compact"><strong>Input Context 尚未读取</strong><span>首次进入该 tab 时才发起 lazy read。</span></div>
    </section>`;
  }
  if (!payload.available) {
    return `<section class="request-interaction">
      <div class="request-inspector-state unavailable">
        <strong>Reconstructed Input Context 当前不可用</strong>
        <span>${escapeHtml(requestInputCoverageLabel(payload.reason))}</span>
      </div>
    </section>`;
  }

  const sections = payload.sections ?? {};
  const currentInput = sections.currentInput ?? [];
  const runtimeContext = sections.runtimeContext ?? [];
  const historyGroups = sections.historyGroups ?? [];
  const compaction = sections.compaction ?? [];
  const gaps = sections.gaps ?? [];
  const currentContent = currentInput.length
    ? currentInput.map(renderRequestContextItem).join("")
    : '<div class="request-inspector-state compact"><strong>当前输入证据不可直接展示</strong><span>当前 cut 可能不可用，或本轮没有可公开的 pre-model item。</span></div>';
  const runtimeContent = runtimeContext.length
    ? runtimeContext.map(renderRequestContextItem).join("")
    : '<p class="request-content-empty">当前 Request slice 没有 allowlisted runtime metadata。</p>';
  const historyContent = historyGroups.length
    ? historyGroups.map((group, index) => renderRequestHistoryGroup(group, index === historyGroups.length - 1)).join("")
    : '<div class="request-inspector-state compact"><strong>没有重建出的 retained history</strong><span>这不代表 Provider Input 没有历史上下文。</span></div>';
  const compactionContent = compaction.length
    ? compaction.map((item) => `<article class="request-context-evidence-card">
        <header><strong>${escapeHtml(item.kind === "compaction_snapshot" ? "Compaction snapshot" : "Compaction signal")}</strong>${renderProvenanceBadge(item.provenance)}</header>
        <p>${escapeHtml(item.label || "Observed compaction evidence")}</p>
      </article>`).join("")
    : '<p class="request-content-empty">当前 bounded history 中没有观察到 compaction evidence。</p>';
  const gapContent = gaps.length
    ? gaps.map((gap) => `<article class="request-context-gap">
        <header><strong>${escapeHtml(requestInputCoverageLabel(gap.reason))}</strong>${renderProvenanceBadge(gap.provenance)}</header>
        <p>${escapeHtml(gap.sourceKey ? `Source: ${gap.sourceKey}` : "Coverage evidence is incomplete.")}</p>
      </article>`).join("")
    : '<p class="request-content-empty">在当前 bounded reconstruction 范围内没有额外 rollout coverage gap。</p>';

  return `<section class="request-input-context" aria-labelledby="request-input-context-title">
    <header class="request-input-context-header">
      <div><p class="eyebrow">RECONSTRUCTED INPUT CONTEXT</p><h3 id="request-input-context-title">重建输入上下文</h3></div>
      <span>${escapeHtml(requestInputCoverageLabel(payload.evidence?.rolloutCoverage))}</span>
    </header>
    <div class="request-input-context-disclaimer">
      <strong>Evidence boundary</strong>
      <span>Reconstructed from local rollout history. Provider payload/serialization unavailable. Token accounting is not allocated to individual items.</span>
    </div>
    <section class="request-context-section">
      <header><h4>Current Input Evidence</h4><span>${tokenFormatter.format(currentInput.length)} items</span></header>
      <div class="request-interaction-list">${currentContent}</div>
    </section>
    <section class="request-context-section">
      <header><h4>Runtime Context</h4><span>${tokenFormatter.format(runtimeContext.length)} records</span></header>
      <div class="request-interaction-list">${runtimeContent}</div>
    </section>
    <section class="request-context-section">
      <header><h4>Retained / Reconstructed History</h4><span>${tokenFormatter.format(historyGroups.length)} groups</span></header>
      <div class="request-history-groups">${historyContent}</div>
    </section>
    <section class="request-context-section">
      <header><h4>Compaction Evidence</h4><span>${tokenFormatter.format(compaction.length)}</span></header>
      <div class="request-context-evidence-list">${compactionContent}</div>
    </section>
    <section class="request-context-section">
      <header><h4>Coverage Gaps</h4><span>${tokenFormatter.format(gaps.length)}</span></header>
      <div class="request-context-evidence-list">${gapContent}</div>
    </section>
  </section>`;
}

function renderRequestHistoryGroup(group, newest) {
  return `<details class="request-history-group"${newest ? " open" : ""}>
    <summary>
      <span><strong>${escapeHtml(group.label || "Historical rollout")}</strong><small>${escapeHtml(group.sourceKey || "portable source unavailable")}</small></span>
      <span>${tokenFormatter.format(group.itemCount ?? group.items?.length ?? 0)} items · ${escapeHtml(provenanceLabel(group.provenance))}</span>
    </summary>
    <div class="request-interaction-list">${(group.items ?? []).map(renderRequestContextItem).join("")}</div>
  </details>`;
}

function renderRequestContextItem(item) {
  const content = renderRequestContentItem(item);
  if (!content) return "";
  return `<div class="request-context-item">${renderProvenanceBadge(item.provenance)}${content}</div>`;
}

function renderProvenanceBadge(provenance) {
  const level = provenance?.level ?? "coverage_gap";
  const location = provenance?.lineStart != null
    ? ` · line ${provenance.lineStart}${provenance.lineEnd != null && provenance.lineEnd !== provenance.lineStart ? `–${provenance.lineEnd}` : ""}`
    : "";
  return `<span class="request-provenance" aria-label="Evidence provenance: ${escapeHtml(provenanceLabel(level))}">${escapeHtml(provenanceLabel(level))}${escapeHtml(location)}</span>`;
}

function provenanceLabel(value) {
  return ({
    direct_current: "Observed current",
    historical_rollout: "Historical rollout",
    compaction_snapshot: "Compaction snapshot",
    runtime_context: "Runtime metadata",
    coverage_gap: "Coverage gap",
  })[value] ?? "Observed evidence";
}

function requestInputCoverageLabel(value) {
  return ({
    complete_observed_history: "Complete observed rollout history",
    partial: "Partial observed history",
    partial_source_missing: "Partial · source missing",
    partial_compaction_snapshot_unavailable: "Partial · compaction snapshot unavailable",
    partial_unsupported_shape: "Partial · unsupported record shape",
    partial_bounded_truncation: "Partial · bounded truncation",
    current_cut_unavailable: "Current pre-model cut unavailable",
    source_rebind_failed: "Source rebind failed",
    boundary_ambiguous: "Source ordering / boundary ambiguous",
    unavailable: "Reconstruction unavailable",
    source_missing: "Source missing",
    current_content_unavailable: "Current interaction unavailable",
  })[value] ?? String(value || "Unknown coverage");
}

function renderRuntimeContextSection(items) {
  if (!items.length) return "";
  const fields = items.flatMap((item) => item.fields ?? []);
  return `<section class="request-interaction request-runtime-context" aria-labelledby="request-runtime-title">
    <header><div><p class="eyebrow">RUNTIME CONTEXT</p><h3 id="request-runtime-title">运行时上下文</h3></div><span>${tokenFormatter.format(fields.length)} fields</span></header>
    <details class="request-content-card runtime-context">
      <summary><strong>Observed runtime metadata</strong><span>非 system/developer prompt dump</span></summary>
      <dl class="request-tool-fields">${fields.map((field) => `
        <div><dt>${escapeHtml(field.label)}</dt><dd class="${field.format === "code" ? "code" : ""}">${renderPlainText(field.value)}</dd>${field.truncated ? '<small>已截断</small>' : ""}</div>
      `).join("")}</dl>
    </details>
  </section>`;
}

function renderRequestInspectorUnavailable(payload) {
  return `<section class="request-interaction">
    <div class="request-inspector-state unavailable">
      <strong>交互正文当前不可用</strong>
      <span>${escapeHtml(requestContentReasonLabel(payload.reason))}</span>
    </div>
  </section>`;
}

function renderRequestContentItem(item) {
  if (item.kind === "runtime_context") {
    const fields = (item.fields ?? []).length
      ? `<dl class="request-tool-fields">${item.fields.map((field) => `
          <div><dt>${escapeHtml(field.label)}</dt><dd class="${field.format === "code" ? "code" : ""}">${renderPlainText(field.value)}</dd>${field.truncated ? '<small>已截断</small>' : ""}</div>
        `).join("")}</dl>`
      : '<p class="request-content-empty">没有可展示的 allowlisted runtime metadata。</p>';
    return `<details class="request-content-card runtime-context">
      <summary><strong>Runtime metadata</strong><span>非 system/developer prompt dump</span></summary>
      ${fields}
    </details>`;
  }
  if (item.kind === "message" || item.kind === "assistant_message") {
    const role = item.kind === "assistant_message" ? "Assistant" : requestRoleLabel(item.role);
    const route = item.author || item.recipient
      ? `<small>${escapeHtml([item.author, item.recipient].filter(Boolean).join(" → "))}</small>`
      : "";
    return `<article class="request-content-card message ${escapeHtml(item.role || "assistant")}">
      <header><strong>${escapeHtml(role)}</strong>${route}</header>
      <div class="request-content-text">${renderPlainText(item.text)}</div>
      ${item.truncated ? '<span class="request-content-truncated">正文已截断</span>' : ""}
    </article>`;
  }
  if (item.kind === "tool_call") {
    const normalizedFields = (item.fields ?? []).length
      ? item.fields
      : typeof item.text === "string" && item.text
        ? [{ label: "Arguments", value: item.text, format: "code", truncated: item.truncated }]
        : [];
    const fields = normalizedFields.length
      ? `<dl class="request-tool-fields">${normalizedFields.map((field) => `
          <div><dt>${escapeHtml(field.label)}</dt><dd class="${field.format === "code" ? "code" : ""}">${renderPlainText(field.value)}</dd>${field.truncated ? '<small>已截断</small>' : ""}</div>
        `).join("")}</dl>`
      : '<p class="request-content-empty">没有可展示参数</p>';
    return `<article class="request-content-card tool-call">
      <header><strong>Tool · ${escapeHtml(item.tool || "unknown")}</strong>${item.status ? `<small>${escapeHtml(item.status)}</small>` : ""}</header>
      ${fields}
    </article>`;
  }
  if (item.kind === "tool_result") {
    const resultIdentity = item.tool && item.tool !== "unknown_tool"
      ? item.tool
      : item.callId || "unknown";
    return `<details class="request-content-card tool-result">
      <summary><strong>Result · ${escapeHtml(resultIdentity)}</strong><span>${tokenFormatter.format(item.lineCount ?? 0)} lines${item.truncated ? " · 已截断" : ""}</span></summary>
      <pre><code>${escapeHtml(item.text || "（空结果）")}</code></pre>
    </details>`;
  }
  if (item.kind === "reasoning_summary") {
    const body = renderPlainText(item.text || "");
    const count = Number(item.occurrenceCount ?? 1);
    const occurrence = count > 1
      ? `${tokenFormatter.format(count)} equivalent summary records`
      : item.opaqueContentPresent ? "存在 opaque reasoning" : "可公开摘要";
    return `<details class="request-content-card reasoning">
      <summary><strong>Reasoning summary</strong><span>${escapeHtml(occurrence)}</span></summary>
      <div class="request-content-text">${body}</div>
      ${item.truncated ? '<span class="request-content-truncated">摘要已截断</span>' : ""}
    </details>`;
  }
  if (item.kind === "reasoning_activity") {
    const count = Number(item.occurrenceCount ?? 1);
    return `<article class="request-content-card reasoning-activity">
      <header><strong>Reasoning activity</strong><small>${tokenFormatter.format(count)} opaque records</small></header>
      <p class="request-content-empty">存在不可公开的 reasoning activity；未推断这些记录的内容相同。</p>
    </article>`;
  }
  if (item.kind === "context_signal") {
    return `<article class="request-content-card context-signal"><header><strong>Context</strong><small>${escapeHtml(item.signal || "signal")}</small></header><p>${escapeHtml(item.label || "检测到上下文状态记录")}</p></article>`;
  }
  return "";
}

function renderRequestInspectorEvidence(evidence, summary) {
  return `<section class="request-evidence-details" aria-label="证据边界">
    <div><strong>Evidence boundary</strong><span>Lines ${escapeHtml(evidence?.startLine ?? "—")}–${escapeHtml(evidence?.endLine ?? "—")}</span></div>
    <div><strong>Coverage</strong><span>${escapeHtml(requestCoverageLabel(evidence?.coverage))}${evidence?.truncated ? " · truncated" : ""}</span></div>
    <div><strong>Observed records</strong><span>${tokenFormatter.format(summary?.observedRecordCount ?? 0)}${summary?.unknownRecordCount ? ` · ${tokenFormatter.format(summary.unknownRecordCount)} unsupported` : ""}${summary?.malformedRecordCount ? ` · ${tokenFormatter.format(summary.malformedRecordCount)} malformed` : ""}</span></div>
    <p>这是一段本地 rollout 的可观察交互证据，不是 Provider HTTP/Responses request body，也不用于推断未记录的历史上下文或 chain-of-thought。</p>
  </section>`;
}

function requestEvidenceLabel(evidence) {
  if (!evidence) return "Rollout observed interaction";
  return `Rollout observed interaction · Lines ${evidence.startLine ?? "—"}–${evidence.endLine ?? "—"}`;
}

function requestCoverageLabel(value) {
  return ({
    complete: "Complete",
    record_parse_partial: "Partial · malformed record",
    content_truncated: "Partial · bounded truncation",
    unsupported_content_shape: "Partial · unsupported record shape",
    source_missing: "Source missing",
    source_rebind_failed: "Source rebind failed",
    task_boundary_unavailable: "Task boundary unavailable",
    boundary_ambiguous: "Boundary ambiguous",
    source_changed: "Source changed",
  })[value] || value || "Unknown";
}

function requestContentReasonLabel(reason) {
  return ({
    source_missing: "原始 rollout 已不存在；Request 的 Token/Cost 元数据仍然有效。",
    source_rebind_failed: "原始 rollout 无法重新绑定到当前 Codex 目录。",
    request_locator_missing: "该 Request 缺少可证明的原始证据定位。",
    task_boundary_unavailable: "当前 Task 缺少可证明的同源读取边界。",
    boundary_ambiguous: "Request 与 Task/source 边界存在歧义，因此没有跨 source 猜测正文。",
    source_changed: "原始 source 的当前内容与持久化 locator 不再一致。",
    content_truncated: "目标 boundary 超出本次 bounded read 上限，因此没有进行无界文件扫描。",
  })[reason] || "当前没有足够证据安全读取该 Request 的交互正文。";
}

function requestRoleLabel(role) {
  return ({ user: "User", developer: "Developer", system: "System", agent: "Agent", assistant: "Assistant" })[role]
    || (role ? String(role) : "Message");
}

function renderPlainText(value) {
  return escapeHtml(value || "").replace(/\r?\n/gu, "<br>");
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

async function postJson(url, body) {
  const headers = { Accept: "application/json" };
  const options = { method: "POST", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
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
  const value = estimate?.amountUsd;
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

function requestCostEstimateTitle(estimate) {
  if (!estimate) return "缺少可审计的 Request pricing evidence。";
  const amount = Number.isFinite(estimate.amountUsd) ? formatUsdAmount(estimate.amountUsd) : null;
  const rate = estimate.rateVersion || "历史价目不可用";
  const tier = serviceTierLabel(estimate.rawServiceTier ?? estimate.serviceTier, estimate);
  if (estimate.status === "estimated") {
    return `价目版本：${rate}；服务层级：${tier}。订阅标准价等值，不是 Plus 实际扣费。`;
  }
  if (estimate.status === "partial") {
    const reason = `pricing evidence 不完整${estimate.reason ? `（${estimate.reason}）` : ""}`;
    return `${amount ? `当前可证明金额 ${amount}；` : ""}价目版本：${rate}；服务层级：${tier}。${reason}。不是 Plus 实际扣费。`;
  }
  return `价目版本：${rate}；服务层级：${tier}。缺少足够的 request-level pricing evidence，无法估算。`;
}

function serviceTierLabel(value, estimate = null) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "fast") {
    const multiplier = Number(estimate?.multipliers?.fast);
    return Number.isFinite(multiplier) && multiplier > 1
      ? `fast · ${formatMultiplier(multiplier)} 倍率`
      : "fast";
  }
  return "standard";
}

function serviceTierClass(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "fast" ? "fast" : "standard";
}

function formatMultiplier(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
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
