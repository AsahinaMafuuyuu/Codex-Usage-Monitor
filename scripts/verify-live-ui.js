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
    const caption = wrap.querySelector('caption:not(.visually-hidden)');
    wrap.scrollLeft = 0;
    const captionBeforeLeft = caption?.getBoundingClientRect().left ?? null;
    wrap.scrollLeft = Math.min(520, Math.max(1, wrap.scrollWidth - wrap.clientWidth));
    const captionAfterLeft = caption?.getBoundingClientRect().left ?? null;
    wrap.focus({ preventScroll: true });
    window.__codexLiveUiQa.scrollLeft = wrap.scrollLeft;
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', {
      data: window.__codexLiveUiQa.snapshotData,
    }));
    return {
      scrollLeft: wrap.scrollLeft,
      detailsOpen: details.open,
      focused: document.activeElement === wrap,
      captionDelta: captionBeforeLeft == null || captionAfterLeft == null ? null : captionAfterLeft - captionBeforeLeft,
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
  assert(identityBefore.captionDelta != null && Math.abs(identityBefore.captionDelta) < 1, `task table caption moved ${identityBefore.captionDelta}px with horizontal columns`);
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
  const taskPagination = await verifyTaskPagination(cdp);
  const scopedNavigation = await verifyScopedNavigation(cdp);
  const narrow = await verifyNarrowViewport(cdp);

  console.log(JSON.stringify({ collapsed, structural, requestDrilldown, taskPagination, scopedNavigation, narrow }, null, 2));
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
    const outer = detail?.closest('.agent-card')?.querySelector(':scope > .task-table-wrap');
    const heading = detail?.querySelector('.request-audit-heading');
    const requestScroll = detail?.querySelector('.request-audit-scroll');
    if (outer) outer.scrollLeft = 0;
    if (requestScroll) requestScroll.scrollLeft = 0;
    return {
      requestRows: detail?.querySelectorAll('.request-table tbody tr').length ?? 0,
      expanded: toggle?.getAttribute('aria-expanded') === 'true',
      hasError: Boolean(detail?.querySelector('.request-detail-state.error')),
      headings: [...(detail?.querySelectorAll('.request-table thead th') ?? [])].map((cell) => cell.textContent.trim()),
      modelStyled: Boolean(detail?.querySelector('.request-model')),
      collapseHandle: Boolean(detail?.querySelector('[data-request-collapse]')),
      paginator: Boolean(detail?.querySelector('.request-pagination')),
      pageText: detail?.querySelector('.request-page-summary')?.textContent?.trim() ?? '',
      independentOverflow: Boolean(requestScroll && requestScroll.scrollWidth > requestScroll.clientWidth),
      headingLeft: heading?.getBoundingClientRect().left ?? null,
    };
  })()`);
  assert(before.expanded, "task Request toggle did not enter expanded state");
  assert(!before.hasError, "task Request drill-down rendered an error");
  assert(before.requestRows > 0, "task with Request count > 0 returned no canonical Request rows");
  assert(before.headings.includes("推理强度"), "Request drill-down is missing Task reasoning effort");
  assert(before.headings.includes("服务层级"), "Request drill-down does not explain service tier");
  assert(!before.headings.includes("Coverage"), "Request drill-down still exposes the removed Coverage column");
  assert(before.modelStyled, "Request model does not use the emphasized model treatment");
  assert(before.requestRows <= 10, `Request page rendered ${before.requestRows} rows instead of at most 10`);
  assert(before.collapseHandle, "Request drill-down is missing the centered collapse handle");
  assert(before.paginator, "Request drill-down is missing numbered pagination");
  assert(/第\s*1\s*\/\s*\d+\s*页/u.test(before.pageText), `Request pagination does not expose current/total pages: ${before.pageText}`);
  assert(before.independentOverflow, "Request table does not own an independent horizontal scrollbar");

  const scrollIsolation = await cdp.evaluate(`(() => {
    const detail = window.__codexLiveUiQa.requestDetail;
    const outer = detail?.closest('.agent-card')?.querySelector(':scope > .task-table-wrap');
    const heading = detail?.querySelector('.request-audit-heading');
    const requestScroll = detail?.querySelector('.request-audit-scroll');
    const firstHead = detail?.querySelector('.request-table thead th');
    if (!outer || !heading || !requestScroll || !firstHead) return null;
    const headingBefore = heading.getBoundingClientRect().left;
    outer.scrollLeft = Math.min(360, Math.max(1, outer.scrollWidth - outer.clientWidth));
    const headingAfterOuter = heading.getBoundingClientRect().left;
    const requestHeadBefore = firstHead.getBoundingClientRect().left;
    requestScroll.scrollLeft = Math.min(220, Math.max(1, requestScroll.scrollWidth - requestScroll.clientWidth));
    const requestHeadAfter = firstHead.getBoundingClientRect().left;
    return {
      outerScrollLeft: outer.scrollLeft,
      requestScrollLeft: requestScroll.scrollLeft,
      headingDelta: headingAfterOuter - headingBefore,
      requestHeadDelta: requestHeadAfter - requestHeadBefore,
    };
  })()`);
  assert(scrollIsolation?.outerScrollLeft > 0, "outer task table did not scroll during isolation QA");
  assert(Math.abs(scrollIsolation.headingDelta) < 1, `Canonical Requests heading moved ${scrollIsolation.headingDelta}px with outer task scroll`);
  assert(scrollIsolation.requestScrollLeft > 0, "Request table did not scroll independently");
  assert(Math.abs(scrollIsolation.requestHeadDelta) > 1, "Request columns did not move inside their own scrollbar");

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

  const collapsedDetail = await cdp.evaluate(`(() => {
    const detail = window.__codexLiveUiQa.requestDetail;
    const panel = detail?.querySelector('.task-request-panel');
    const transitionDuration = panel ? getComputedStyle(panel).transitionDuration : '';
    detail?.querySelector('[data-request-collapse]')?.click();
    const toggle = [...document.querySelectorAll('.task-row')]
      .find((row) => row.dataset.threadId === ${JSON.stringify(target.threadId)} && row.dataset.taskId === ${JSON.stringify(target.turnId)})
      ?.querySelector('.task-request-toggle');
    return {
      sameDetail: Boolean(detail?.isConnected && document.contains(detail)),
      openState: detail?.dataset.open ?? null,
      expanded: toggle?.getAttribute('aria-expanded') === 'true',
      transitionDuration,
    };
  })()`);
  assert(collapsedDetail.sameDetail, "collapse removed the Request detail instead of animating the stable drawer");
  assert(collapsedDetail.openState === "false" && !collapsedDetail.expanded, "Request collapse handle did not close the drawer");
  assert(collapsedDetail.transitionDuration && collapsedDetail.transitionDuration !== "0s", "Request drawer has no collapse/expand transition");

  await cdp.evaluate(`(() => {
    const toggle = [...document.querySelectorAll('.task-row')]
      .find((row) => row.dataset.threadId === ${JSON.stringify(target.threadId)} && row.dataset.taskId === ${JSON.stringify(target.turnId)})
      ?.querySelector('.task-request-toggle');
    toggle?.click();
  })()`);
  await sleep(30);
  const reopened = await cdp.evaluate(`(() => ({
    sameDetail: Boolean(window.__codexLiveUiQa.requestDetail?.isConnected && document.contains(window.__codexLiveUiQa.requestDetail)),
    openState: window.__codexLiveUiQa.requestDetail?.dataset.open ?? null,
  }))()`);
  assert(reopened.sameDetail && reopened.openState === "true", "Request drawer did not reopen in place after collapse");
  return { target, before, scrollIsolation, after, collapsedDetail, reopened };
}

async function verifyTaskPagination(cdp) {
  const result = await cdp.evaluate(`(() => {
    const original = JSON.parse(window.__codexLiveUiQa.snapshotData);
    const agent = original.agents.find((item) => item.tasks?.length);
    if (!agent) return { skipped: true, reason: 'no task agent available' };
    const seed = structuredClone(agent.tasks[0]);
    agent.tasks = Array.from({ length: 23 }, (_, index) => ({
      ...structuredClone(seed),
      turnId: '__codex-task-page-' + String(index + 1).padStart(2, '0') + '__',
      sequence: index + 1,
      requestCount: index + 1,
    }));
    agent.taskCount = agent.tasks.length;
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', { data: JSON.stringify(original) }));
    const branch = document.querySelector('[data-agent-id="' + CSS.escape(agent.threadId) + '"]');
    const pager = branch?.querySelector('.task-pagination');
    const page1 = branch?.querySelectorAll('tr.task-row').length ?? 0;
    const summary1 = pager?.querySelector('.task-page-summary')?.textContent?.trim() ?? '';
    pager?.querySelector('[data-task-page-action="next"]')?.click();
    const nextPager = branch?.querySelector('.task-pagination');
    const page2 = branch?.querySelectorAll('tr.task-row').length ?? 0;
    const summary2 = nextPager?.querySelector('.task-page-summary')?.textContent?.trim() ?? '';
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', { data: window.__codexLiveUiQa.snapshotData }));
    return { skipped: false, page1, page2, summary1, summary2, hasJump: Boolean(nextPager?.querySelector('[data-task-page-jump]')) };
  })()`);
  assert(!result.skipped, result.reason || "task pagination QA was skipped");
  assert(result.page1 === 10, `Task page 1 rendered ${result.page1} rows instead of 10`);
  assert(result.page2 === 10, `Task page 2 rendered ${result.page2} rows instead of 10`);
  assert(/第\s*1\s*\/\s*3\s*页/u.test(result.summary1), `Task page summary is wrong: ${result.summary1}`);
  assert(/第\s*2\s*\/\s*3\s*页/u.test(result.summary2), `Task next-page navigation failed: ${result.summary2}`);
  assert(result.hasJump, "Task pagination is missing page jump input");
  return result;
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
