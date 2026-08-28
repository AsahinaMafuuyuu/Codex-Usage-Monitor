import { attachRequestIdentities } from "./request-identity.js";
import { USAGE_FIELDS, zeroUsage } from "./usage.js";

const VERIFIED_CLASSIFICATIONS = new Set(["verified_increment", "generation_start"]);

export function resolveCanonicalRequestOwnership({
  agents = [],
  tasks = [],
  events = [],
  rootCreatedAt = null,
  externalCanonicalRequestIds = new Set(),
} = {}) {
  const identifiedEvents = attachRequestIdentities(events);
  const externalRequestIds = externalCanonicalRequestIds instanceof Set
    ? externalCanonicalRequestIds
    : new Set(externalCanonicalRequestIds ?? []);
  const turnsWithCurrentVerifiedRequests = new Set();
  if (externalRequestIds.size > 0) {
    for (const event of identifiedEvents) {
      if (!VERIFIED_CLASSIFICATIONS.has(event?.classification)) continue;
      if (!event?.turnId || !event?.requestIdentity) continue;
      if (!externalRequestIds.has(event.requestIdentity)) {
        turnsWithCurrentVerifiedRequests.add(event.turnId);
      }
    }
  }
  const agentsById = new Map(agents.map((agent) => [agent.threadId, agent]));
  const tasksByTurn = new Map();
  for (const task of tasks) {
    if (!task?.turnId || !task?.threadId) continue;
    const rows = tasksByTurn.get(task.turnId) ?? [];
    rows.push(task);
    tasksByTurn.set(task.turnId, rows);
  }

  const ownerByTurn = new Map();
  const ownershipStatusByTurn = new Map();
  const candidateThreadsByTurn = new Map();
  const ownership = [];
  for (const [turnId, rows] of tasksByTurn) {
    const resolved = taskPredatesRootSession(rows, rootCreatedAt) &&
      !turnsWithCurrentVerifiedRequests.has(turnId)
      ? {
          status: "inherited_copy",
          ownerThreadId: null,
          duplicateCount: Math.max(0, rows.length - 1),
          reason: "predates_root_session",
        }
      : resolveTaskOwner(rows, agentsById);
    if (resolved.status === "canonical") ownerByTurn.set(turnId, resolved.ownerThreadId);
    ownershipStatusByTurn.set(turnId, resolved.status);
    candidateThreadsByTurn.set(turnId, new Set(rows.map((row) => row.threadId)));
    ownership.push({ turnId, ...resolved });
  }

  const canonicalEvidenceByRequestId = new Map();
  for (const event of identifiedEvents) {
    if (!VERIFIED_CLASSIFICATIONS.has(event?.classification)) continue;
    if (event?.requestIdentity && externalRequestIds.has(event.requestIdentity)) continue;
    const ownerThreadId = event?.turnId ? ownerByTurn.get(event.turnId) : null;
    if (!ownerThreadId || event.threadId !== ownerThreadId || !event.requestIdentity) continue;
    const previous = canonicalEvidenceByRequestId.get(event.requestIdentity);
    if (!previous || compareEvidenceLocation(event, previous) < 0) {
      canonicalEvidenceByRequestId.set(event.requestIdentity, event);
    }
  }

  const reconciliation = createReconciliation();
  const provenance = [];
  const eventResults = [];
  const externalInheritedTurns = new Set();
  const verifiedNonExternalTurns = new Set();
  for (const event of identifiedEvents) {
    const ownerThreadId = event?.turnId ? ownerByTurn.get(event.turnId) : null;
    const verified = VERIFIED_CLASSIFICATIONS.has(event?.classification);
    const externallyOwned = Boolean(
      verified && event?.requestIdentity && externalRequestIds.has(event.requestIdentity)
    );
    const canonicalEvidence = event?.requestIdentity
      ? canonicalEvidenceByRequestId.get(event.requestIdentity)
      : null;
    let status = "unresolved";
    if (externallyOwned) {
      status = "inherited_copy";
      if (event?.turnId) externalInheritedTurns.add(event.turnId);
    } else if (verified) {
      if (event?.turnId) verifiedNonExternalTurns.add(event.turnId);
      if (canonicalEvidence && sameEvidenceLocation(event, canonicalEvidence)) {
        status = "canonical";
      } else if (
        canonicalEvidence &&
        ownerThreadId &&
        (event.threadId === ownerThreadId || candidateThreadsByTurn.get(event.turnId)?.has(event.threadId))
      ) {
        status = "inherited_copy";
      } else if (ownershipStatusByTurn.get(event?.turnId) === "inherited_copy") {
        status = "inherited_copy";
      }
    } else if (ownerThreadId && event.threadId === ownerThreadId) {
      status = "canonical";
    } else if (ownerThreadId && candidateThreadsByTurn.get(event.turnId)?.has(event.threadId)) {
      status = "inherited_copy";
    } else if (ownershipStatusByTurn.get(event?.turnId) === "inherited_copy") {
      status = "inherited_copy";
    }

    provenance.push({
      sourceKey: event?.sourceKey ?? null,
      lineNumber: event?.lineNumber ?? null,
      turnId: event?.turnId ?? null,
      threadId: event?.threadId ?? null,
      ownerThreadId: externallyOwned ? null : ownerThreadId,
      status,
      requestIdentity: event?.requestIdentity ?? null,
      requestIdentityKind: event?.requestIdentityKind ?? "unresolved",
      requestIdentityReason: event?.requestIdentityReason ?? null,
      requestNativeField: event?.requestNativeField ?? null,
      canonicalRequestId: externallyOwned
        ? event.requestIdentity
        : canonicalEvidence?.requestIdentity ?? null,
    });

    eventResults.push({ event, verified, status });
    accumulateReconciliation(reconciliation, status, event);
  }

  const crossRootInheritedTurns = new Set();
  for (const row of ownership) {
    if (
      row.status === "canonical" &&
      externalInheritedTurns.has(row.turnId) &&
      !verifiedNonExternalTurns.has(row.turnId)
    ) {
      row.status = "inherited_copy";
      row.ownerThreadId = null;
      row.reason = "cross_root_request_owner";
      ownerByTurn.delete(row.turnId);
      crossRootInheritedTurns.add(row.turnId);
    }
  }
  if (crossRootInheritedTurns.size > 0) {
    for (let index = 0; index < provenance.length; index += 1) {
      const row = provenance[index];
      if (!crossRootInheritedTurns.has(row.turnId)) continue;
      row.status = "inherited_copy";
      row.ownerThreadId = null;
      if (!row.canonicalRequestId && row.requestIdentity && externalRequestIds.has(row.requestIdentity)) {
        row.canonicalRequestId = row.requestIdentity;
      }
      eventResults[index].status = "inherited_copy";
    }
  }

  const canonicalTasks = [];
  for (const row of tasks) {
    const ownerThreadId = ownerByTurn.get(row.turnId);
    if (ownerThreadId && ownerThreadId === row.threadId) canonicalTasks.push(row);
  }
  const canonicalEvents = eventResults
    .filter((row) => row.status === "canonical")
    .map((row) => row.event);
  const canonicalRequests = eventResults
    .filter((row) => row.status === "canonical" && row.verified)
    .map((row) => row.event);

  finalizeReconciliation(reconciliation);
  return {
    tasks: canonicalTasks,
    events: canonicalEvents,
    requests: canonicalRequests,
    ownership,
    provenance,
    reconciliation,
  };
}

function taskPredatesRootSession(rows, rootCreatedAt) {
  const rootCreatedMs = Date.parse(rootCreatedAt ?? "");
  if (!Number.isFinite(rootCreatedMs) || rows.length === 0) return false;
  return rows.every((row) => {
    const taskStartMs = Date.parse(row?.startedAt ?? "");
    return Number.isFinite(taskStartMs) && taskStartMs < rootCreatedMs - 5_000;
  });
}

function compareEvidenceLocation(left, right) {
  return String(left?.sourceKey ?? "").localeCompare(String(right?.sourceKey ?? "")) ||
    Number(left?.lineNumber ?? Number.MAX_SAFE_INTEGER) - Number(right?.lineNumber ?? Number.MAX_SAFE_INTEGER);
}

function sameEvidenceLocation(left, right) {
  return left?.sourceKey === right?.sourceKey && Number(left?.lineNumber) === Number(right?.lineNumber);
}

function resolveTaskOwner(rows, agentsById) {
  if (rows.length === 1) {
    return {
      status: "canonical",
      ownerThreadId: rows[0].threadId,
      duplicateCount: 0,
      reason: "single_owner",
    };
  }

  const candidates = [...rows].sort((left, right) =>
    taskDepth(left, agentsById) - taskDepth(right, agentsById) ||
    compareTimestamp(left.startedAt, right.startedAt) ||
    String(left.threadId).localeCompare(String(right.threadId)),
  );
  const plausible = candidates.filter((row) => !threadProvablyCreatedAfterTask(row, agentsById));
  if (plausible.length === 1) {
    return {
      status: "canonical",
      ownerThreadId: plausible[0].threadId,
      duplicateCount: rows.length - 1,
      reason: "temporal_owner",
    };
  }
  const ownerCandidates = plausible.length ? plausible : candidates;
  const candidate = ownerCandidates[0];
  const allDescendants = ownerCandidates.slice(1).every((row) =>
    isAncestor(candidate.threadId, row.threadId, agentsById)
  );
  if (!allDescendants) {
    return {
      status: "unresolved",
      ownerThreadId: null,
      duplicateCount: rows.length - 1,
      reason: "non_lineage_collision",
    };
  }
  return {
    status: "canonical",
    ownerThreadId: candidate.threadId,
    duplicateCount: rows.length - 1,
    reason: "ancestor_owner",
  };
}

function threadProvablyCreatedAfterTask(task, agentsById) {
  const firstSeenMs = Date.parse(agentsById.get(task.threadId)?.firstSeenAt ?? "");
  const taskStartMs = Date.parse(task.startedAt ?? "");
  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(taskStartMs)) return false;
  return firstSeenMs > taskStartMs + 5_000;
}

function isAncestor(ancestorThreadId, descendantThreadId, agentsById) {
  if (!ancestorThreadId || !descendantThreadId || ancestorThreadId === descendantThreadId) return false;
  const visited = new Set();
  let current = agentsById.get(descendantThreadId);
  while (current?.parentThreadId && !visited.has(current.threadId)) {
    visited.add(current.threadId);
    if (current.parentThreadId === ancestorThreadId) return true;
    current = agentsById.get(current.parentThreadId);
  }
  return false;
}

function taskDepth(task, agentsById) {
  const depth = Number(agentsById.get(task.threadId)?.depth);
  return Number.isFinite(depth) ? depth : Number.MAX_SAFE_INTEGER;
}

function compareTimestamp(left, right) {
  const leftMs = Date.parse(left ?? "");
  const rightMs = Date.parse(right ?? "");
  if (!Number.isFinite(leftMs) && !Number.isFinite(rightMs)) return 0;
  if (!Number.isFinite(leftMs)) return 1;
  if (!Number.isFinite(rightMs)) return -1;
  return leftMs - rightMs;
}

function createReconciliation() {
  return {
    rawVerifiedEvents: 0,
    canonicalVerifiedEvents: 0,
    inheritedVerifiedEvents: 0,
    unresolvedVerifiedEvents: 0,
    rawVerifiedTokens: 0,
    canonicalVerifiedTokens: 0,
    inheritedVerifiedTokens: 0,
    unresolvedVerifiedTokens: 0,
    rawUsage: zeroUsage(),
    canonicalUsage: zeroUsage(),
    inheritedUsage: zeroUsage(),
    unresolvedUsage: zeroUsage(),
    conserved: true,
  };
}

function accumulateReconciliation(reconciliation, status, event) {
  if (!VERIFIED_CLASSIFICATIONS.has(event?.classification) || !event?.usage) return;
  const prefix = status === "canonical"
    ? "canonical"
    : status === "inherited_copy"
      ? "inherited"
      : "unresolved";
  reconciliation.rawVerifiedEvents += 1;
  reconciliation[`${prefix}VerifiedEvents`] += 1;
  const total = Number(event.usage.totalTokens ?? 0);
  reconciliation.rawVerifiedTokens += total;
  reconciliation[`${prefix}VerifiedTokens`] += total;
  addUsageInPlace(reconciliation.rawUsage, event.usage);
  addUsageInPlace(reconciliation[`${prefix}Usage`], event.usage);
}

function addUsageInPlace(target, usage) {
  for (const field of USAGE_FIELDS) {
    const value = usage?.[field];
    if (value == null) continue;
    target[field] += Number(value);
  }
}

function finalizeReconciliation(reconciliation) {
  reconciliation.conserved = USAGE_FIELDS.every((field) =>
    reconciliation.rawUsage[field] ===
      reconciliation.canonicalUsage[field] +
      reconciliation.inheritedUsage[field] +
      reconciliation.unresolvedUsage[field]
  );
}
