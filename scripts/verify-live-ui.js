import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const appUrl = process.argv[2];
if (!appUrl) {
  throw new Error("Usage: node scripts/verify-live-ui.js <authenticated monitor URL>");
}

const chromePath = resolveChromePath();
const profile = await mkdtemp(join(tmpdir(), "codex-monitor-live-ui-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore" });

let socket;
try {
  const port = await waitForDebugPort(profile);
  const target = await waitForPageTarget(port);
  socket = await connectCdp(target.webSocketDebuggerUrl);
  const cdp = createCdpClient(socket);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      (() => {
        const NativeEventSource = window.EventSource;
        window.__codexLiveUiQa = { snapshotListener: null, snapshotData: null };
        window.EventSource = class InstrumentedEventSource extends NativeEventSource {
          addEventListener(type, listener, options) {
            if (type !== "snapshot") return super.addEventListener(type, listener, options);
            window.__codexLiveUiQa.snapshotListener = listener;
            return super.addEventListener(type, (event) => {
              window.__codexLiveUiQa.snapshotData = event.data;
              listener(event);
            }, options);
          }
        };
      })();
    `,
  });
  await cdp.send("Page.navigate", { url: appUrl });

  await waitFor(async () => cdp.evaluate(`Boolean(
    document.querySelector('.task-table-wrap') &&
    document.querySelector('.agent-card') &&
    window.__codexLiveUiQa?.snapshotListener &&
    window.__codexLiveUiQa?.snapshotData
  )`), "dashboard and initial SSE snapshot");

  await cdp.evaluate(`(() => {
    const wrap = document.querySelector('.task-table-wrap');
    const details = wrap.closest('.agent-card');
    details.open = true;
    window.__codexLiveUiQa.wrap = wrap;
    window.__codexLiveUiQa.details = details;
  })()`);
  await sleep(300);

  const identityBefore = await cdp.evaluate(`(() => {
    const wrap = window.__codexLiveUiQa.wrap;
    const details = window.__codexLiveUiQa.details;
    wrap.scrollLeft = Math.min(520, Math.max(1, wrap.scrollWidth - wrap.clientWidth));
    wrap.focus({ preventScroll: true });
    window.__codexLiveUiQa.scrollLeft = wrap.scrollLeft;
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', {
      data: window.__codexLiveUiQa.snapshotData,
    }));
    return {
      scrollLeft: wrap.scrollLeft,
      detailsOpen: details.open,
      focused: document.activeElement === wrap,
    };
  })()`);

  const identityAfter = await cdp.evaluate(`(() => ({
    sameWrap: window.__codexLiveUiQa.wrap.isConnected && document.contains(window.__codexLiveUiQa.wrap),
    sameDetails: window.__codexLiveUiQa.details.isConnected && document.contains(window.__codexLiveUiQa.details),
    scrollLeft: window.__codexLiveUiQa.wrap.scrollLeft,
    detailsOpen: window.__codexLiveUiQa.details.open,
    focused: document.activeElement === window.__codexLiveUiQa.wrap,
    activeElement: document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : null,
  }))()`);

  console.log(JSON.stringify({ identityBefore, identityAfter }, null, 2));
  assert(identityBefore.scrollLeft > 0, "task table did not have horizontal overflow to test");
  assert(identityBefore.focused, "task table could not obtain focus before snapshot replay");
  assert(identityAfter.sameWrap, "snapshot replaced .task-table-wrap");
  assert(identityAfter.sameDetails, "snapshot replaced .agent-card");
  assert(identityAfter.scrollLeft === identityBefore.scrollLeft, "snapshot changed task-table scrollLeft");
  assert(identityAfter.detailsOpen, "snapshot overwrote the open Agent state");
  assert(identityAfter.focused, "snapshot dropped focus from the task-table region");

  const collapsed = await cdp.evaluate(`(() => {
    window.__codexLiveUiQa.details.open = false;
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', {
      data: window.__codexLiveUiQa.snapshotData,
    }));
    return {
      sameDetails: window.__codexLiveUiQa.details.isConnected && document.contains(window.__codexLiveUiQa.details),
      detailsOpen: window.__codexLiveUiQa.details.open,
      scrollLeft: window.__codexLiveUiQa.wrap.scrollLeft,
    };
  })()`);
  assert(collapsed.sameDetails, "collapsed Agent was replaced by snapshot rendering");
  assert(!collapsed.detailsOpen, "snapshot reopened a manually collapsed Agent");
  assert(collapsed.scrollLeft === identityBefore.scrollLeft, "collapsed table lost its horizontal position");

  const structural = await cdp.evaluate(`(() => {
    const original = JSON.parse(window.__codexLiveUiQa.snapshotData);
    const wrap = window.__codexLiveUiQa.wrap;
    const details = window.__codexLiveUiQa.details;
    details.open = true;
    const branch = wrap.closest('[data-agent-id]');
    const agentId = branch?.dataset.agentId;
    const agent = original.agents.find((item) => item.threadId === agentId && item.tasks.length);
    if (!agent) return { skipped: true, reason: 'no keyed task agent available' };
    const anchorRow = wrap.querySelector('[data-task-id]');
    const spacer = document.createElement('div');
    spacer.style.height = '1200px';
    spacer.dataset.liveUiQaSpacer = 'true';
    document.body.append(spacer);
    anchorRow.scrollIntoView({ block: 'start' });
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const selectedAnchor = [...document.querySelector('#agent-tree').querySelectorAll('[data-agent-anchor-id], [data-task-id]')]
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < viewportHeight;
      });
    const beforeTop = anchorRow.getBoundingClientRect().top;
    const beforeScrollY = window.scrollY;
    const fake = structuredClone(agent.tasks[0]);
    fake.turnId = '__codex-live-ui-qa-task__';
    fake.sequence = Number.isFinite(fake.sequence) ? fake.sequence - 1 : -1;
    agent.tasks.unshift(fake);
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', {
      data: JSON.stringify(original),
    }));
    const afterTop = anchorRow.getBoundingClientRect().top;
    const fakePresent = Boolean(wrap.querySelector('[data-task-id="__codex-live-ui-qa-task__"]'));
    const result = {
      skipped: false,
      sameAnchor: anchorRow.isConnected && document.contains(anchorRow),
      beforeTop,
      afterTop,
      topDelta: afterTop - beforeTop,
      scrollDelta: window.scrollY - beforeScrollY,
      fakePresent,
      selectedAnchorTaskId: selectedAnchor?.dataset.taskId ?? null,
      expectedAnchorTaskId: anchorRow.dataset.taskId,
    };
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', {
      data: window.__codexLiveUiQa.snapshotData,
    }));
    spacer.remove();
    return result;
  })()`);

  assert(!structural.skipped, structural.reason || "structural anchor test was skipped");
  assert(structural.selectedAnchorTaskId === structural.expectedAnchorTaskId, "browser QA did not position the intended task as the first visible stable anchor");
  assert(structural.fakePresent, "synthetic structural task was not inserted");
  assert(structural.sameAnchor, "existing task row identity changed during structural update");
  assert(Math.abs(structural.topDelta) < 1, `visual anchor moved by ${structural.topDelta}px`);

  const requestDrilldown = await verifyRequestDrilldown(cdp);
  const scopedNavigation = await verifyScopedNavigation(cdp);
  const narrow = await verifyNarrowViewport(cdp);

  console.log(JSON.stringify({ collapsed, structural, requestDrilldown, scopedNavigation, narrow }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await sleep(250);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

async function verifyRequestDrilldown(cdp) {
  const target = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.task-request-toggle')];
    const button = buttons.find((candidate) => Number.parseInt(candidate.querySelector('span')?.textContent ?? '0', 10) > 0);
    if (!button) return null;
    const row = button.closest('.task-row');
    button.click();
    return { threadId: row?.dataset.threadId ?? null, turnId: row?.dataset.taskId ?? null };
  })()`);
  assert(target?.threadId && target?.turnId, "no task with canonical Requests was available for drill-down QA");
  await waitFor(async () => cdp.evaluate(`(() => {
    const detail = [...document.querySelectorAll('.task-request-row')]
      .find((row) => row.dataset.taskDetailId === ${JSON.stringify(target.turnId)});
    return Boolean(detail?.querySelector('.request-table tbody tr')) || Boolean(detail?.querySelector('.request-detail-state.error'));
  })()`), "canonical Request drill-down");

  const before = await cdp.evaluate(`(() => {
    const detail = [...document.querySelectorAll('.task-request-row')]
      .find((row) => row.dataset.taskDetailId === ${JSON.stringify(target.turnId)});
    const toggle = [...document.querySelectorAll('.task-row')]
      .find((row) => row.dataset.threadId === ${JSON.stringify(target.threadId)} && row.dataset.taskId === ${JSON.stringify(target.turnId)})
      ?.querySelector('.task-request-toggle');
    window.__codexLiveUiQa.requestDetail = detail;
    return {
      requestRows: detail?.querySelectorAll('.request-table tbody tr').length ?? 0,
      expanded: toggle?.getAttribute('aria-expanded') === 'true',
      hasError: Boolean(detail?.querySelector('.request-detail-state.error')),
      headings: [...(detail?.querySelectorAll('.request-table thead th') ?? [])].map((cell) => cell.textContent.trim()),
      modelStyled: Boolean(detail?.querySelector('.request-model')),
    };
  })()`);
  assert(before.expanded, "task Request toggle did not enter expanded state");
  assert(!before.hasError, "task Request drill-down rendered an error");
  assert(before.requestRows > 0, "task with Request count > 0 returned no canonical Request rows");
  assert(before.headings.includes("推理强度"), "Request drill-down is missing Task reasoning effort");
  assert(before.headings.includes("服务层级"), "Request drill-down does not explain service tier");
  assert(!before.headings.includes("Coverage"), "Request drill-down still exposes the removed Coverage column");
  assert(before.modelStyled, "Request model does not use the emphasized model treatment");

  const after = await cdp.evaluate(`(() => {
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', {
      data: window.__codexLiveUiQa.snapshotData,
    }));
    const toggle = [...document.querySelectorAll('.task-row')]
      .find((row) => row.dataset.threadId === ${JSON.stringify(target.threadId)} && row.dataset.taskId === ${JSON.stringify(target.turnId)})
      ?.querySelector('.task-request-toggle');
    return {
      sameDetail: Boolean(window.__codexLiveUiQa.requestDetail?.isConnected && document.contains(window.__codexLiveUiQa.requestDetail)),
      expanded: toggle?.getAttribute('aria-expanded') === 'true',
      requestRows: window.__codexLiveUiQa.requestDetail?.querySelectorAll('.request-table tbody tr').length ?? 0,
    };
  })()`);
  assert(after.sameDetail, "snapshot replaced the expanded Request detail row");
  assert(after.expanded, "snapshot lost Task Request expansion state");
  assert(after.requestRows === before.requestRows, "snapshot changed loaded Request detail without projection invalidation");
  return { target, before, after };
}

async function verifyScopedNavigation(cdp) {
  await cdp.evaluate(`document.querySelector('[data-session-view="time"]')?.click()`);
  await waitFor(async () => cdp.evaluate(`Boolean(
    document.querySelector('.time-session-item.active[data-session-day]') &&
    document.querySelector('#session-version')?.textContent.includes('当日')
  )`), "day-scoped time selection");

  const timeState = await cdp.evaluate(`(() => {
    const active = document.querySelector('.time-session-item.active[data-session-day]');
    const caption = document.querySelector('.task-table.day-scope caption');
    const sameSessionDays = [...document.querySelectorAll('.time-session-item[data-session-day]')]
      .filter((button) => button.dataset.sessionId === active?.dataset.sessionId)
      .map((button) => button.dataset.sessionDay);
    return {
      sessionId: active?.dataset.sessionId ?? null,
      day: active?.dataset.sessionDay ?? null,
      versionLabel: document.querySelector('#session-version')?.textContent ?? '',
      sameSessionDays: [...new Set(sameSessionDays)],
      taskCountLabel: document.querySelector('#task-count-label')?.textContent ?? '',
      tableCaption: caption?.textContent ?? '',
      captionPosition: caption ? getComputedStyle(caption).position : '',
      captionWidth: caption ? getComputedStyle(caption).width : '',
      tableHeadings: [...document.querySelectorAll('.task-table.day-scope thead th')].map((cell) => cell.textContent.trim()),
    };
  })()`);
  assert(timeState.sessionId && timeState.day, "time navigation did not expose composite selection identity");
  assert(timeState.versionLabel.includes(timeState.day), "day snapshot label does not match active Timeline day");
  assert(timeState.taskCountLabel === "活动任务", "Time summary does not label Task Day Slice as 活动任务");
  assert(timeState.tableCaption === "当日任务活动", "Time task table does not identify itself as 当日任务活动");
  assert(timeState.captionPosition === "absolute" && timeState.captionWidth === "1px", "Time task caption is still visually occupying a table row");
  assert(timeState.tableHeadings.includes("当日首请求") && timeState.tableHeadings.includes("当日末请求"), "Time task table is missing Request window columns");
  assert(timeState.tableHeadings.includes("Requests"), "Time task table is missing explicit Requests count");
  assert(timeState.tableHeadings.includes("推理强度"), "Time task table is missing reasoning effort");
  assert(!timeState.tableHeadings.includes("开始") && !timeState.tableHeadings.includes("耗时"), "Time task table still exposes full Task lifecycle columns as day metrics");

  let crossDay = { skipped: true, reason: "selected live session has only one Timeline day" };
  if (timeState.sameSessionDays.length > 1) {
    const nextDay = timeState.sameSessionDays.find((day) => day !== timeState.day);
    await cdp.evaluate(`(() => {
      const target = [...document.querySelectorAll('.time-session-item[data-session-day]')]
        .find((button) => button.dataset.sessionId === ${JSON.stringify(timeState.sessionId)} &&
          button.dataset.sessionDay === ${JSON.stringify(nextDay)});
      target?.click();
    })()`);
    await waitFor(async () => cdp.evaluate(`Boolean(
      document.querySelector('.time-session-item.active')?.dataset.sessionDay === ${JSON.stringify(nextDay)} &&
      document.querySelector('#session-version')?.textContent.includes(${JSON.stringify(nextDay)})
    )`), "same-session alternate day selection");
    crossDay = { skipped: false, from: timeState.day, to: nextDay };
  }

  await cdp.evaluate(`document.querySelector('[data-session-view="project"]')?.click()`);
  await waitFor(async () => cdp.evaluate(`Boolean(
    document.querySelector('[data-session-view="project"].active') &&
    !document.querySelector('#session-version')?.textContent.includes('当日')
  )`), "full-session project selection");
  await waitFor(async () => cdp.evaluate(`(() => {
    try {
      const snapshot = JSON.parse(window.__codexLiveUiQa?.snapshotData ?? 'null');
      return snapshot?.scope?.type === 'session';
    } catch {
      return false;
    }
  })()`), "full-session project SSE snapshot");
  const projectState = await cdp.evaluate(`(() => ({
    taskCountLabel: document.querySelector('#task-count-label')?.textContent ?? '',
    tableCaption: document.querySelector('.task-table.session-scope caption')?.textContent ?? '',
    tableHeadings: [...document.querySelectorAll('.task-table.session-scope thead th')].map((cell) => cell.textContent.trim()),
  }))()`);
  assert(projectState.taskCountLabel === "任务记录", "Project summary no longer labels full Tasks as 任务记录");
  assert(projectState.tableCaption === "任务记录", "Project task table does not identify full Task scope");
  assert(projectState.tableHeadings.includes("开始") && projectState.tableHeadings.includes("耗时"), "Project task table lost full Task lifecycle columns");
  assert(projectState.tableHeadings.includes("Requests"), "Project task table is missing explicit Requests count");
  return { timeState, crossDay, projectState, projectRestoredFullScope: true };
}

async function verifyNarrowViewport(cdp) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(250);
  const result = await cdp.evaluate(`(() => {
    const wrap = document.querySelector('.task-table-wrap');
    const details = wrap?.closest('.agent-card');
    if (details) details.open = true;
    if (wrap) {
      wrap.scrollLeft = Math.min(240, Math.max(1, wrap.scrollWidth - wrap.clientWidth));
      wrap.focus({ preventScroll: true });
    }
    const before = wrap?.scrollLeft ?? 0;
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', {
      data: window.__codexLiveUiQa.snapshotData,
    }));
    return {
      innerWidth: window.innerWidth,
      overflow: Boolean(wrap && wrap.scrollWidth > wrap.clientWidth),
      before,
      after: wrap?.scrollLeft ?? 0,
      focused: document.activeElement === wrap,
      detailsOpen: Boolean(details?.open),
    };
  })()`);
  assert(result.innerWidth === 720, `narrow viewport is ${result.innerWidth}px instead of 720px`);
  assert(result.overflow, "narrow task table lost horizontal overflow");
  assert(result.before > 0 && result.after === result.before, "narrow snapshot changed task-table scrollLeft");
  assert(result.focused, "narrow snapshot dropped task-table focus");
  assert(result.detailsOpen, "narrow snapshot changed Agent expansion state");
  return result;
}

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean);
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Chrome not found; set CHROME_PATH to chrome.exe");
  return path;
}

async function waitForDebugPort(profilePath) {
  const portFile = join(profilePath, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [port] = (await readFile(portFile, "utf8")).trim().split(/\r?\n/u);
      if (port) return Number(port);
    } catch {}
    await sleep(100);
  }
  throw new Error("Chrome DevTools port did not become available");
}

async function waitForPageTarget(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {}
    await sleep(100);
  }
  throw new Error("Chrome page target did not become available");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return socket;
}

function createCdpClient(socket) {
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
      }
      return result.result.value;
    },
  };
}

async function waitFor(probe, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await probe()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
