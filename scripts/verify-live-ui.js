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
    const caption = wrap.querySelector('.task-table-heading');
    wrap.scrollLeft = 0;
    const captionBeforeLeft = caption?.getBoundingClientRect().left ?? null;
    wrap.scrollLeft = Math.min(520, Math.max(1, wrap.scrollWidth - wrap.clientWidth));
    if (wrap.scrollHeight > wrap.clientHeight) wrap.scrollTop = Math.min(120, wrap.scrollHeight - wrap.clientHeight);
    const captionAfterLeft = caption?.getBoundingClientRect().left ?? null;
    wrap.focus({ preventScroll: true });
    window.__codexLiveUiQa.scrollLeft = wrap.scrollLeft;
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', {
      data: window.__codexLiveUiQa.snapshotData,
    }));
    return {
      scrollLeft: wrap.scrollLeft,
      scrollTop: wrap.scrollTop,
      detailsOpen: details.open,
      focused: document.activeElement === wrap,
      captionDelta: captionBeforeLeft == null || captionAfterLeft == null ? null : captionAfterLeft - captionBeforeLeft,
    };
  })()`);

  const identityAfter = await cdp.evaluate(`(() => ({
    sameWrap: window.__codexLiveUiQa.wrap.isConnected && document.contains(window.__codexLiveUiQa.wrap),
    sameDetails: window.__codexLiveUiQa.details.isConnected && document.contains(window.__codexLiveUiQa.details),
    scrollLeft: window.__codexLiveUiQa.wrap.scrollLeft,
    scrollTop: window.__codexLiveUiQa.wrap.scrollTop,
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
  assert(identityAfter.scrollTop === identityBefore.scrollTop, "snapshot changed task-table scrollTop");
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
  const taskScroll = await verifyTaskScroll(cdp);
  const diagnostics = await verifyDiagnostics(cdp);
  const scopedNavigation = await verifyScopedNavigation(cdp);
  const narrow = await verifyNarrowViewport(cdp);

  console.log(JSON.stringify({ collapsed, structural, requestDrilldown, taskScroll, diagnostics, scopedNavigation, narrow }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await sleep(250);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

async function verifyRequestDrilldown(cdp) {
  const target = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.task-request-toggle')];
    const requestCount = (candidate) => Number.parseInt(candidate.querySelector('.request-count-pill')?.textContent ?? '0', 10);
    const button = buttons.find((candidate) => requestCount(candidate) >= 10);
    if (!button) return null;
    const row = button.closest('.task-row');
    button.click();
    return {
      threadId: row?.dataset.threadId ?? null,
      turnId: row?.dataset.taskId ?? null,
      requestCount: requestCount(button),
    };
  })()`);
  assert(target?.threadId && target?.turnId, "no task with at least 10 canonical Requests was available for pagination QA");
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
    const pageEdge = detail?.querySelector('.page-edge:not(:disabled)') ?? detail?.querySelector('.page-edge');
    const pageIcon = pageEdge?.querySelector('.page-nav-icon');
    const edgeRect = pageEdge?.getBoundingClientRect();
    const iconRect = pageIcon?.getBoundingClientRect();
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
      pageSizeOptions: [...(detail?.querySelectorAll('[data-request-page-size]') ?? [])].map((button) => button.textContent.trim()),
      jumpInputType: detail?.querySelector('[data-request-page-jump]')?.getAttribute('type') ?? null,
      paginationAlignment: detail?.querySelector('.request-pagination') ? getComputedStyle(detail.querySelector('.request-pagination')).justifyContent : null,
      navIconCenterDelta: edgeRect && iconRect ? {
        x: (iconRect.left + iconRect.width / 2) - (edgeRect.left + edgeRect.width / 2),
        y: (iconRect.top + iconRect.height / 2) - (edgeRect.top + edgeRect.height / 2),
      } : null,
      paginationAnimation: detail?.querySelector('.request-pagination') ? getComputedStyle(detail.querySelector('.request-pagination')).animationName : '',
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
  assert(before.pageSizeOptions.join(',') === '5,10', `Request pagination page-size options are wrong: ${before.pageSizeOptions.join(',')}`);
  assert(before.jumpInputType === 'text', `Request jump still exposes numeric spinner semantics: ${before.jumpInputType}`);
  assert(before.paginationAlignment === 'center', `Request pagination is not centered: ${before.paginationAlignment}`);
  assert(before.navIconCenterDelta && Math.abs(before.navIconCenterDelta.x) < 1 && Math.abs(before.navIconCenterDelta.y) < 1,
    `Request navigation icon is not centered: ${JSON.stringify(before.navIconCenterDelta)}`);
  assert(before.paginationAnimation && before.paginationAnimation !== 'none', "Request pagination has no transition animation");
  assert(before.independentOverflow, "Request table does not own an independent horizontal scrollbar");

  await cdp.evaluate(`window.__codexLiveUiQa.requestDetail?.querySelector('[data-request-page-size="5"]')?.click()`);
  await waitFor(async () => cdp.evaluate(`(() => {
    const detail = window.__codexLiveUiQa.requestDetail;
    return detail?.querySelectorAll('.request-table tbody tr').length === 5 &&
      detail?.querySelector('[data-request-page-size="5"]')?.getAttribute('aria-pressed') === 'true';
  })()`), "Request page size 5");
  const fivePerPage = await cdp.evaluate(`(() => ({
    requestRows: window.__codexLiveUiQa.requestDetail?.querySelectorAll('.request-table tbody tr').length ?? 0,
    pageText: window.__codexLiveUiQa.requestDetail?.querySelector('.request-page-summary')?.textContent?.trim() ?? '',
  }))()`);
  assert(fivePerPage.requestRows === 5, `Request page-size switch rendered ${fivePerPage.requestRows} rows instead of 5`);
  await cdp.evaluate(`window.__codexLiveUiQa.requestDetail?.querySelector('[data-request-page-size="10"]')?.click()`);
  await waitFor(async () => cdp.evaluate(`window.__codexLiveUiQa.requestDetail?.querySelectorAll('.request-table tbody tr').length === 10`), "Request page size 10 restore");

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

  const exclusiveOpen = await cdp.evaluate(`(() => {
    const targetRow = [...document.querySelectorAll('.task-row')]
      .find((row) => row.dataset.threadId === ${JSON.stringify(target.threadId)} && row.dataset.taskId === ${JSON.stringify(target.turnId)});
    const alternate = [...document.querySelectorAll('.task-request-toggle')].find((button) => {
      const row = button.closest('.task-row');
      return row && row !== targetRow && Number.parseInt(button.querySelector('.request-count-pill')?.textContent ?? '0', 10) > 0;
    });
    if (!alternate) return { skipped: true, reason: 'no second task with Requests available' };
    const alternateRow = alternate.closest('.task-row');
    const alternateThreadId = alternateRow?.dataset.threadId ?? null;
    const alternateTurnId = alternateRow?.dataset.taskId ?? null;
    alternate.click();
    const openDrawers = [...document.querySelectorAll('.task-request-row[data-open="true"]')];
    const targetExpanded = targetRow?.querySelector('.task-request-toggle')?.getAttribute('aria-expanded') === 'true';
    const freshAlternate = [...document.querySelectorAll('.task-row')]
      .find((row) => row.dataset.threadId === alternateThreadId && row.dataset.taskId === alternateTurnId)
      ?.querySelector('.task-request-toggle');
    const alternateExpanded = freshAlternate?.getAttribute('aria-expanded') === 'true';
    const result = {
      skipped: false,
      openCount: openDrawers.length,
      targetExpanded,
      alternateExpanded,
      alternateTurnId,
    };
    targetRow?.querySelector('.task-request-toggle')?.click();
    return result;
  })()`);
  if (!exclusiveOpen.skipped) {
    assert(exclusiveOpen.openCount === 1, `opening a second Request drawer left ${exclusiveOpen.openCount} drawers open`);
    assert(!exclusiveOpen.targetExpanded && exclusiveOpen.alternateExpanded, "latest Request drawer did not exclusively own the expanded state");
  }
  return { target, before, fivePerPage, scrollIsolation, after, collapsedDetail, reopened, exclusiveOpen };
}

async function verifyTaskScroll(cdp) {
  const setup = await cdp.evaluate(`(() => {
    const original = JSON.parse(window.__codexLiveUiQa.snapshotData);
    const agent = original.agents.find((item) => item.tasks?.length);
    if (!agent) return { skipped: true, reason: 'no task agent available' };
    window.__codexLiveUiQa.taskScrollOriginal = original;
    window.__codexLiveUiQa.taskScrollAgentId = agent.threadId;
    const seed = structuredClone(agent.tasks[0]);
    agent.tasks = Array.from({ length: 23 }, (_, index) => ({
      ...structuredClone(seed),
      turnId: '__codex-task-scroll-' + String(index + 1).padStart(2, '0') + '__',
      sequence: index + 1,
      requestCount: index + 1,
    }));
    agent.taskCount = agent.tasks.length;
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', { data: JSON.stringify(original) }));
    const branch = document.querySelector('[data-agent-id="' + CSS.escape(agent.threadId) + '"]');
    const wrap = branch?.querySelector('.task-table-wrap');
    const rows = branch?.querySelectorAll('tr.task-row').length ?? 0;
    const before = wrap?.scrollTop ?? 0;
    if (wrap) wrap.scrollTop = Math.min(240, wrap.scrollHeight - wrap.clientHeight);
    const after = wrap?.scrollTop ?? 0;
    const workspace = document.querySelector('.workspace');
    const spacer = document.createElement('div');
    spacer.dataset.taskScrollQaSpacer = 'true';
    spacer.style.height = '1200px';
    branch?.after(spacer);
    if (wrap) {
      wrap.scrollTop = wrap.scrollHeight - wrap.clientHeight;
      wrap.scrollIntoView({ block: 'center' });
    }
    const rect = wrap?.getBoundingClientRect();
    const metrics = wrap ? {
      clientHeight: wrap.clientHeight,
      scrollHeight: wrap.scrollHeight,
      overflowY: getComputedStyle(wrap).overflowY,
      overscrollBehaviorY: getComputedStyle(wrap).overscrollBehaviorY,
    } : null;
    const hasPager = Boolean(branch?.querySelector('.task-pagination'));
    return {
      skipped: false,
      rows,
      before,
      after,
      metrics,
      hasPager,
      x: rect ? rect.left + Math.min(120, rect.width / 2) : 0,
      y: rect ? Math.min(window.innerHeight - 20, rect.top + rect.height / 2) : 0,
      workspaceBefore: workspace?.scrollTop ?? 0,
      wrapBottom: wrap ? wrap.scrollTop : 0,
    };
  })()`);
  assert(!setup.skipped, setup.reason || "task scroll QA was skipped");
  assert(setup.rows === 23, `Task scroll rendered ${setup.rows} rows instead of all 23`);
  assert(!setup.hasPager, "Task list still renders pagination instead of vertical scrolling");
  assert(setup.metrics?.scrollHeight > setup.metrics?.clientHeight, "Task list does not overflow vertically after five-row viewport");
  assert(setup.metrics?.clientHeight <= 530, `Task viewport is taller than the intended five-row size: ${setup.metrics?.clientHeight}`);
  assert(setup.after > setup.before, "Task list vertical scrollbar did not move");
  assert(setup.metrics?.overscrollBehaviorY === 'auto', `Task vertical overscroll does not chain: ${setup.metrics?.overscrollBehaviorY}`);

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: setup.x,
    y: setup.y,
    deltaX: 0,
    deltaY: 320,
  });
  await sleep(120);
  const bottomChain = await cdp.evaluate(`(() => {
    const branch = document.querySelector('[data-agent-id="' + CSS.escape(window.__codexLiveUiQa.taskScrollAgentId) + '"]');
    const wrap = branch?.querySelector('.task-table-wrap');
    const workspace = document.querySelector('.workspace');
    return {
      workspaceAfter: workspace?.scrollTop ?? 0,
      wrapAfter: wrap?.scrollTop ?? 0,
      wrapMax: wrap ? wrap.scrollHeight - wrap.clientHeight : 0,
    };
  })()`);
  assert(bottomChain.workspaceAfter > setup.workspaceBefore, "wheel at Task bottom was swallowed instead of scrolling the workspace");
  assert(Math.abs(bottomChain.wrapAfter - bottomChain.wrapMax) < 1, "Task wrap moved past its bottom boundary during scroll chaining");

  const noOverflowSetup = await cdp.evaluate(`(() => {
    const original = structuredClone(window.__codexLiveUiQa.taskScrollOriginal);
    const agent = original.agents.find((item) => item.threadId === window.__codexLiveUiQa.taskScrollAgentId);
    agent.tasks = agent.tasks.slice(0, Math.min(2, agent.tasks.length));
    agent.taskCount = agent.tasks.length;
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', { data: JSON.stringify(original) }));
    const branch = document.querySelector('[data-agent-id="' + CSS.escape(agent.threadId) + '"]');
    const wrap = branch?.querySelector('.task-table-wrap');
    const workspace = document.querySelector('.workspace');
    wrap?.scrollIntoView({ block: 'center' });
    const rect = wrap?.getBoundingClientRect();
    const workspaceMax = workspace ? Math.max(0, workspace.scrollHeight - workspace.clientHeight) : 0;
    const deltaY = workspace && workspaceMax - workspace.scrollTop > 360 ? 320 : -320;
    return {
      noOverflow: Boolean(wrap && wrap.scrollHeight <= wrap.clientHeight),
      x: rect ? rect.left + Math.min(120, rect.width / 2) : 0,
      y: rect ? Math.min(window.innerHeight - 20, rect.top + rect.height / 2) : 0,
      workspaceBefore: workspace?.scrollTop ?? 0,
      workspaceMax,
      deltaY,
    };
  })()`);
  assert(noOverflowSetup.noOverflow, "Task no-overflow fixture unexpectedly has a vertical scrollbar");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: noOverflowSetup.x,
    y: noOverflowSetup.y,
    deltaX: 0,
    deltaY: noOverflowSetup.deltaY,
  });
  await sleep(120);
  const noOverflowChain = await cdp.evaluate(`document.querySelector('.workspace')?.scrollTop ?? 0`);
  const noOverflowMoved = noOverflowSetup.deltaY > 0
    ? noOverflowChain > noOverflowSetup.workspaceBefore
    : noOverflowChain < noOverflowSetup.workspaceBefore;
  assert(noOverflowMoved, "wheel over a Task list without vertical overflow was swallowed");

  await cdp.evaluate(`(() => {
    document.querySelector('[data-task-scroll-qa-spacer]')?.remove();
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', { data: window.__codexLiveUiQa.snapshotData }));
  })()`);
  return { ...setup, bottomChain, noOverflowSetup, noOverflowChain };
}

async function verifyDiagnostics(cdp) {
  await cdp.evaluate(`document.querySelector('[data-session-view="project"]')?.click()`);
  await waitFor(async () => cdp.evaluate(`Boolean(document.querySelector('[data-session-view="project"].active'))`), "project scope before diagnostics QA");
  const target = await cdp.evaluate(`(async () => {
    const currentId = document.querySelector('#session-id')?.textContent?.trim() ?? '';
    const candidates = [];
    if (currentId) candidates.push(currentId);
    const sessionsPayload = await fetch('/api/sessions').then((response) => response.json());
    for (const session of sessionsPayload.sessions ?? []) {
      if (!candidates.includes(session.id)) candidates.push(session.id);
      if (candidates.length >= 50) break;
    }
    for (const sessionId of candidates) {
      const [localResponse, advancedResponse] = await Promise.all([
        fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/diagnostics'),
        fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/advanced-diagnostics'),
      ]);
      if (!localResponse.ok || !advancedResponse.ok) continue;
      const report = await localResponse.json();
      const advanced = await advancedResponse.json();
      const finding = (report.findings ?? []).find((candidate) =>
        candidate?.requestId && candidate?.threadId && candidate?.turnId &&
        Number.isInteger(candidate?.locator?.requestOrdinalInScope)
      );
      const advancedFinding = (advanced.findings ?? []).find((candidate) =>
        candidate?.family === 'historical' && candidate?.locator?.requestId &&
        candidate?.locator?.threadId && candidate?.locator?.turnId &&
        Number.isInteger(candidate?.locator?.requestOrdinalInScope)
      );
      if (finding && advancedFinding) return {
        sessionId,
        findingId: finding.findingId,
        advancedFindingId: advancedFinding.findingId,
      };
    }
    return null;
  })()`);
  assert(target?.sessionId && target?.findingId && target?.advancedFindingId,
    "no session with locatable Local and Historical Usage Diagnostics findings was found in the first 50 sessions");

  const activeId = await cdp.evaluate(`document.querySelector('#session-id')?.textContent?.trim() ?? ''`);
  if (activeId !== target.sessionId) {
    const clicked = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('[data-session-id]')]
        .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(target.sessionId)} && !candidate.dataset.sessionDay);
      button?.click();
      return Boolean(button);
    })()`);
    assert(clicked, `diagnostics target session ${target.sessionId} is not present in project navigation`);
    await waitFor(async () => cdp.evaluate(`document.querySelector('#session-id')?.textContent?.trim() === ${JSON.stringify(target.sessionId)}`), "diagnostics target session selection");
  }

  await waitFor(async () => cdp.evaluate(`(() => {
    const summary = document.querySelector('#diagnostics-summary')?.textContent?.trim() ?? '';
    return summary && !summary.includes('正在分析') && !summary.includes('等待会话') && !summary.includes('读取失败');
  })()`), "lazy diagnostics summary");

  const lazyState = await cdp.evaluate(`(() => {
    const snapshot = JSON.parse(window.__codexLiveUiQa?.snapshotData ?? 'null');
    return {
      summary: document.querySelector('#diagnostics-summary')?.textContent?.trim() ?? '',
      snapshotHasDiagnostics: Boolean(snapshot && (
        Object.prototype.hasOwnProperty.call(snapshot, 'diagnostics') ||
        Object.prototype.hasOwnProperty.call(snapshot, 'diagnosticSummary')
      )),
      panelInitiallyHidden: Boolean(document.querySelector('#diagnostics-panel')?.hidden),
    };
  })()`);
  assert(!lazyState.snapshotHasDiagnostics, "regular SSE snapshot eagerly carries Diagnostics payload");
  assert(lazyState.panelInitiallyHidden, "Diagnostics panel is not collapsed by default");

  await cdp.evaluate(`document.querySelector('#diagnostics-toggle')?.click()`);
  await waitFor(async () => cdp.evaluate(`Boolean(
    !document.querySelector('#diagnostics-panel')?.hidden &&
    document.querySelector('.diagnostic-finding') &&
    document.querySelector('[data-diagnostic-locate]')
  )`), "diagnostics finding panel");

  await waitFor(async () => cdp.evaluate(`(() => {
    const text = document.querySelector('#diagnostic-alert-summary')?.textContent?.trim() ?? '';
    return Boolean(text && !text.includes('正在读取') && !text.includes('未加载') && !text.includes('读取失败'));
  })()`), "diagnostic alerts lazy load");

  const alertState = await cdp.evaluate(`(() => ({
    summary: document.querySelector('#diagnostic-alert-summary')?.textContent?.trim() ?? '',
    budgetValue: document.querySelector('#diagnostic-budget-usd')?.value ?? null,
    severity: document.querySelector('#diagnostic-alert-severity')?.value ?? null,
    cooldown: document.querySelector('#diagnostic-alert-cooldown')?.value ?? null,
    formPresent: Boolean(document.querySelector('#diagnostic-alert-policy-form')),
    note: document.querySelector('.diagnostic-alert-note')?.textContent?.trim() ?? '',
    alertCount: document.querySelectorAll('.diagnostic-alert-item').length,
  }))()`);
  assert(alertState.formPresent, "Diagnostic Alerts policy form is missing");
  assert(alertState.severity === 'high' || alertState.severity === 'warning',
    `Diagnostic Alerts severity is invalid: ${alertState.severity}`);
  assert(/Subscription Standard-Rate Equivalent/u.test(alertState.note),
    `Diagnostic Alerts budget disclaimer is missing: ${alertState.note}`);
  assert(/不外发/u.test(alertState.note),
    `Diagnostic Alerts local-only notification boundary is missing: ${alertState.note}`);

  const familyState = await cdp.evaluate(`(() => ({
    families: [...document.querySelectorAll('[data-diagnostic-family]')].map((section) => ({
      family: section.dataset.diagnosticFamily,
      heading: section.querySelector('.diagnostics-family-heading strong')?.textContent?.trim() ?? '',
      count: Number(section.querySelector('.diagnostics-family-heading code')?.textContent ?? '0'),
    })),
    advancedText: [...document.querySelectorAll('[data-diagnostic-family="historical"] .diagnostic-meta')]
      .map((element) => element.textContent).join(' '),
  }))()`);
  assert(familyState.families.map((entry) => entry.family).join(',') === 'local,historical,cross_session,behavioral_request,behavioral_session',
    `Diagnostics baseline families are wrong: ${JSON.stringify(familyState.families)}`);
  assert(familyState.families.find((entry) => entry.family === 'historical')?.count > 0,
    "Historical Diagnostics group has no finding for the selected QA session");
  assert(/median/u.test(familyState.advancedText) && /MAD/u.test(familyState.advancedText) && /Z\s/u.test(familyState.advancedText),
    `Historical finding does not expose median/MAD/Robust-Z evidence: ${familyState.advancedText}`);

  const locateTarget = await cdp.evaluate(`(() => {
    const control = document.querySelector('[data-diagnostic-family="local"] [data-diagnostic-locate]');
    if (!control) return null;
    const finding = control.closest('.diagnostic-finding');
    const requestId = finding?.querySelector('.diagnostic-meta code')?.getAttribute('title') ?? null;
    window.__codexLiveUiQa.diagnosticPanel = document.querySelector('#diagnostics-panel');
    control.click();
    return {
      findingId: control.dataset.diagnosticLocate,
      requestId,
    };
  })()`);
  assert(locateTarget?.requestId, "Diagnostics locate action could not resolve its canonical finding");
  await waitFor(async () => cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('tr[data-request-id]')]
      .find((candidate) => candidate.dataset.requestId === ${JSON.stringify(locateTarget.requestId)});
    return Boolean(row?.classList.contains('diagnostic-target'));
  })()`), "diagnostics canonical Request location");

  const located = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('tr[data-request-id]')]
      .find((candidate) => candidate.dataset.requestId === ${JSON.stringify(locateTarget.requestId)});
    const detail = row?.closest('.task-request-row');
    const panel = document.querySelector('#diagnostics-panel');
    return {
      rowFound: Boolean(row),
      highlighted: Boolean(row?.classList.contains('diagnostic-target')),
      requestId: row?.dataset.requestId ?? null,
      drawerOpen: detail?.dataset.open === 'true',
      marker: row?.querySelector('.request-diagnostic-marker')?.textContent?.trim() ?? null,
      panelOpen: Boolean(panel && !panel.hidden),
    };
  })()`);
  assert(located.rowFound && located.requestId === locateTarget.requestId, "Diagnostics locator opened the wrong canonical Request");
  assert(located.highlighted, "Diagnostics locator did not apply the lightweight target highlight");
  assert(located.drawerOpen, "Diagnostics locator did not open the existing canonical Request drawer");
  assert(Number(located.marker) >= 1, "located Request does not expose its lightweight Diagnostics marker");
  assert(located.panelOpen, "Diagnostics locator unexpectedly collapsed the finding panel");

  const afterSse = await cdp.evaluate(`(() => {
    const panel = window.__codexLiveUiQa.diagnosticPanel;
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', {
      data: window.__codexLiveUiQa.snapshotData,
    }));
    const row = [...document.querySelectorAll('tr[data-request-id]')]
      .find((candidate) => candidate.dataset.requestId === ${JSON.stringify(locateTarget.requestId)});
    return {
      samePanel: Boolean(panel?.isConnected && document.contains(panel)),
      panelOpen: Boolean(panel && !panel.hidden),
      drawerOpen: row?.closest('.task-request-row')?.dataset.open === 'true',
      requestStillPresent: Boolean(row),
    };
  })()`);
  assert(afterSse.samePanel && afterSse.panelOpen, "SSE snapshot replaced or collapsed the Diagnostics panel");
  assert(afterSse.drawerOpen && afterSse.requestStillPresent, "SSE snapshot lost the Diagnostics-located Request drawer");

  const advancedLocateTarget = await cdp.evaluate(`(() => {
    const control = document.querySelector('[data-diagnostic-family="historical"] [data-diagnostic-locate]');
    if (!control) return null;
    const finding = control.closest('.diagnostic-finding');
    const requestId = finding?.querySelector('.diagnostic-meta code')?.getAttribute('title') ?? null;
    control.click();
    return {
      requestId,
      family: 'historical',
    };
  })()`);
  assert(advancedLocateTarget?.requestId && advancedLocateTarget.family === 'historical',
    "Historical Diagnostics locate action could not resolve its canonical evidence");
  await waitFor(async () => cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('tr[data-request-id]')]
      .find((candidate) => candidate.dataset.requestId === ${JSON.stringify(advancedLocateTarget.requestId)});
    return Boolean(row?.classList.contains('diagnostic-target'));
  })()`), "historical diagnostics canonical Request location");

  const behavioralTarget = await cdp.evaluate(`(async () => {
    const sessionsPayload = await fetch('/api/sessions').then((response) => response.json());
    const sessions = sessionsPayload.sessions ?? [];
    for (let start = 0; start < sessions.length; start += 12) {
      const batch = sessions.slice(start, start + 12);
      const results = await Promise.all(batch.map(async (session) => {
        const response = await fetch('/api/sessions/' + encodeURIComponent(session.id) + '/behavioral-diagnostics');
        if (!response.ok) return null;
        const report = await response.json();
        const finding = (report.findings ?? []).find((candidate) =>
          candidate?.requestId &&
          (candidate.family === 'behavioral_request' || candidate.family === 'behavioral_session')
        );
        return finding ? {
          sessionId: session.id,
          findingId: finding.findingId,
          family: finding.family,
          requestId: finding.requestId,
        } : null;
      }));
      const match = results.find(Boolean);
      if (match) return match;
    }
    return null;
  })()`);
  assert(behavioralTarget?.sessionId && behavioralTarget?.findingId && behavioralTarget?.requestId,
    "no locatable Behavioral Diagnostics finding was found in the live database");

  const currentBehavioralSession = await cdp.evaluate(`document.querySelector('#session-id')?.textContent?.trim() ?? ''`);
  if (currentBehavioralSession !== behavioralTarget.sessionId) {
    const clicked = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('[data-session-id]')]
        .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(behavioralTarget.sessionId)} && !candidate.dataset.sessionDay);
      button?.click();
      return Boolean(button);
    })()`);
    assert(clicked, `behavioral diagnostics target session ${behavioralTarget.sessionId} is not present in project navigation`);
    await waitFor(async () => cdp.evaluate(`document.querySelector('#session-id')?.textContent?.trim() === ${JSON.stringify(behavioralTarget.sessionId)}`), "behavioral diagnostics target selection");
  }
  await waitFor(async () => cdp.evaluate(`(() => {
    const summary = document.querySelector('#diagnostics-summary')?.textContent?.trim() ?? '';
    return summary && !summary.includes('正在分析') && !summary.includes('读取失败');
  })()`), "behavioral diagnostics lazy load");
  const behavioralPanelHidden = await cdp.evaluate(`Boolean(document.querySelector('#diagnostics-panel')?.hidden)`);
  if (behavioralPanelHidden) await cdp.evaluate(`document.querySelector('#diagnostics-toggle')?.click()`);
  await waitFor(async () => cdp.evaluate(`Boolean(
    document.querySelector('[data-diagnostic-family="behavioral_request"]') &&
    document.querySelector('[data-diagnostic-family="behavioral_session"]')
  )`), "behavioral diagnostics families");
  const behavioralState = await cdp.evaluate(`(() => {
    const requestFamily = document.querySelector('[data-diagnostic-family="behavioral_request"]');
    const sessionFamily = document.querySelector('[data-diagnostic-family="behavioral_session"]');
    const target = [...document.querySelectorAll('[data-diagnostic-locate]')]
      .find((candidate) => candidate.dataset.diagnosticLocate === ${JSON.stringify(behavioralTarget.findingId)});
    const metaText = target?.closest('.diagnostic-finding')?.querySelector('.diagnostic-meta')?.textContent ?? '';
    return {
      requestCount: Number(requestFamily?.querySelector('.diagnostics-family-heading code')?.textContent ?? '0'),
      sessionCount: Number(sessionFamily?.querySelector('.diagnostics-family-heading code')?.textContent ?? '0'),
      targetPresent: Boolean(target),
      metaText,
    };
  })()`);
  assert(behavioralState.targetPresent, "Behavioral finding is missing from the combined Diagnostics panel");
  assert(/median/u.test(behavioralState.metaText) && /MAD/u.test(behavioralState.metaText) && /Z\s/u.test(behavioralState.metaText),
    `Behavioral finding does not expose median/MAD/Robust-Z evidence: ${behavioralState.metaText}`);
  await cdp.evaluate(`(() => {
    const target = [...document.querySelectorAll('[data-diagnostic-locate]')]
      .find((candidate) => candidate.dataset.diagnosticLocate === ${JSON.stringify(behavioralTarget.findingId)});
    target?.click();
  })()`);
  await waitFor(async () => cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('tr[data-request-id]')]
      .find((candidate) => candidate.dataset.requestId === ${JSON.stringify(behavioralTarget.requestId)});
    return Boolean(row?.classList.contains('diagnostic-target'));
  })()`), "behavioral diagnostics canonical Request location");

  return { target, lazyState, alertState, familyState, locateTarget, located, afterSse, advancedLocateTarget, behavioralTarget, behavioralState };
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
  await cdp.evaluate(`(() => {
    const wrap = document.querySelector('.task-table-wrap');
    const details = wrap?.closest('.agent-card');
    if (details) details.open = true;
  })()`);
  await sleep(260);
  const result = await cdp.evaluate(`(async () => {
    const currentSessionId = document.querySelector('#session-id')?.textContent?.trim() ?? '';
    const response = await fetch('/api/sessions/' + encodeURIComponent(currentSessionId));
    if (!response.ok) throw new Error('failed to refresh current snapshot for narrow QA');
    const currentSnapshotData = JSON.stringify(await response.json());
    const wrap = document.querySelector('.task-table-wrap');
    const details = wrap?.closest('.agent-card');
    if (wrap) {
      wrap.scrollLeft = Math.min(240, Math.max(1, wrap.scrollWidth - wrap.clientWidth));
      wrap.focus({ preventScroll: true });
    }
    const before = wrap?.scrollLeft ?? 0;
    const focusedBeforeReplay = document.activeElement === wrap;
    window.__codexLiveUiQa.snapshotListener(new MessageEvent('snapshot', {
      data: currentSnapshotData,
    }));
    const diagnosticsPanel = document.querySelector('#diagnostics-panel');
    const diagnosticsRect = diagnosticsPanel?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      overflow: Boolean(wrap && wrap.scrollWidth > wrap.clientWidth),
      before,
      after: wrap?.scrollLeft ?? 0,
      focusedBeforeReplay,
      focused: document.activeElement === wrap,
      sameWrap: Boolean(wrap?.isConnected && document.contains(wrap)),
      activeElement: document.activeElement
        ? document.activeElement.tagName + '.' + document.activeElement.className
        : null,
      detailsOpen: Boolean(details?.open),
      diagnosticsFitsViewport: !diagnosticsRect || (
        diagnosticsRect.left >= -1 && diagnosticsRect.right <= window.innerWidth + 1
      ),
    };
  })()`);
  assert(result.innerWidth === 720, `narrow viewport is ${result.innerWidth}px instead of 720px`);
  assert(result.overflow, "narrow task table lost horizontal overflow");
  assert(result.before > 0 && result.after === result.before, "narrow snapshot changed task-table scrollLeft");
  assert(result.focusedBeforeReplay, `narrow task table could not obtain focus before replay: ${result.activeElement}`);
  assert(result.sameWrap, "narrow snapshot replaced task-table wrap");
  assert(result.focused, `narrow snapshot dropped task-table focus to ${result.activeElement}`);
  assert(result.detailsOpen, "narrow snapshot changed Agent expansion state");
  assert(result.diagnosticsFitsViewport, "Diagnostics panel overflows the 720px viewport");
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
