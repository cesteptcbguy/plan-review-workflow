export type PrerequisiteCompletionState = {
  stage?: string;
  decision?: string;
  acceptanceStatus?: string;
  returnToRunFile?: string;
};

export type WorkflowPurpose = 'implementation' | 'planning-document-delivery' | 'verification' | 'external-evidence';

export type PrerequisiteDecisionContext = {
  hasWaitingWorkflow: boolean;
  purpose?: WorkflowPurpose;
};

/**
 * A linked implementation prerequisite still needs the implementation cycle.
 * Evidence, verification, and bounded document-delivery prerequisites may finish
 * directly after their evidence is checked.
 */
export function normalizePrerequisitePlanningDecision(decision: string, context: PrerequisiteDecisionContext | boolean): string {
  const normalized = typeof context === 'boolean' ? { hasWaitingWorkflow: context } : context;
  if (!normalized.hasWaitingWorkflow || decision !== 'PREREQUISITE_COMPLETE') return decision;
  return (normalized.purpose ?? 'implementation') === 'implementation' ? 'READY_TO_CODE' : decision;
}

export function inferWorkflowPurpose(text: string): WorkflowPurpose {
  if (/\b(?:planning[- ]document delivery|write[- ]enabled.*delivery)\b/i.test(text)
    || /\b(?:write|update|create|deliver|publish)\b.{0,80}\b(?:planning document|draft|backlog|roadmap)\b/i.test(text)) return 'planning-document-delivery';
  if (/\b(?:verification|verify|evidence|inspection|read[- ]only review)\b/i.test(text)) return 'verification';
  if (/\b(?:human support|account team|credential|permission|external service|outside observation)\b/i.test(text)) return 'external-evidence';
  return 'implementation';
}

export function prerequisitePublicationPrefix(phasePath: number[] | undefined, prerequisitePath: number[] | undefined): string {
  const phase = (phasePath ?? []).map(value => String(value).padStart(2, '0'));
  const prerequisite = (prerequisitePath ?? []).map(value => `p${String(value).padStart(2, '0')}`);
  if (!prerequisite.length) return phase.join('-');
  return [...(phase.length ? phase : ['00']), ...prerequisite].join('-');
}

export type PrerequisiteReport = {
  reportId: string;
  sourceRunId: string;
  completedAt: string;
  purpose: WorkflowPurpose;
  outcome: 'complete';
  summary: string;
  evidencePaths: string[];
  digest: string;
};

export function attachPrerequisiteReport<T extends PrerequisiteReport>(existing: T[] | undefined, report: T): { reports: T[]; added: boolean } {
  const reports = [...(existing ?? [])];
  if (reports.some(item => item.reportId === report.reportId || (item.sourceRunId === report.sourceRunId && item.digest === report.digest))) {
    return { reports, added: false };
  }
  reports.push(report);
  return { reports, added: true };
}

export type ParentPrerequisiteOutcome = 'needs-owner-input' | 'resume-parent-work';

/** A completed child clears only its gate; it never completes its parent. */
export function parentOutcomeAfterPrerequisite(pendingOwnerWork: string[] | undefined): ParentPrerequisiteOutcome {
  return (pendingOwnerWork ?? []).some(item => item.trim()) ? 'needs-owner-input' : 'resume-parent-work';
}

/**
 * Owner work is removed only after the orchestrator names the exact item and the
 * current reply contains affirmative evidence. A generic or explicitly pending
 * reply never clears the queue.
 */
export function resolvePendingOwnerWork(
  pendingOwnerWork: string[] | undefined,
  currentReply: string,
  claimedResolvedItems: string[] | undefined,
): { remaining: string[]; resolved: string[] } {
  const pending = [...new Set((pendingOwnerWork ?? []).map(item => item.trim()).filter(Boolean))];
  const reply = currentReply.trim();
  if (!reply || !claimedResolvedItems?.length) {
    return { remaining: pending, resolved: [] };
  }
  const byKey = new Map(pending.map(item => [item.toLocaleLowerCase().replace(/\s+/g, ' '), item]));
  const resolved = [...new Set(claimedResolvedItems.flatMap(item => {
    const match = byKey.get(String(item).trim().toLocaleLowerCase().replace(/\s+/g, ' '));
    if (!match) return [];
    if (/approv|authoriz/i.test(match)) {
      return reply === `Owner decision: ${match} — APPROVE` ? [match] : [];
    }
    // An answer about implementation cannot settle another owner question.
    const prefix = `Resolved owner item: ${match} — answer:`;
    const answer = reply.split('\n').find(line => line.trim().startsWith(prefix));
    const value = answer?.trim().slice(prefix.length).trim() ?? '';
    return value && !/\b(?:still pending|unanswered|not answered|cannot answer|deferred)\b/i.test(value) ? [match] : [];
  }))];
  const resolvedKeys = new Set(resolved);
  return { remaining: pending.filter(item => !resolvedKeys.has(item)), resolved };
}

/** Rechecking identical evidence and repository state must not consume another review round. */
export function prerequisiteEvidenceChanged(
  previousSubmission: string | undefined,
  previousRepositoryDigest: string | undefined,
  submission: string,
  repositoryDigest: string,
): boolean {
  return previousSubmission !== submission || previousRepositoryDigest !== repositoryDigest;
}

/** Explanatory prose is deliberately excluded from completion detection. */
export function isCompletedPrerequisiteState(record: PrerequisiteCompletionState): boolean {
  return Boolean(record.returnToRunFile)
    && record.stage === 'prerequisite_complete'
    && record.decision === 'PREREQUISITE_COMPLETE'
    && record.acceptanceStatus === 'complete';
}

/** A requirements-review ceiling still allows a human-directed focused pass. */
export function planningCheckpointInteractionType(atChildLimit: boolean): 'childLimit' | 'morePlanning' {
  return atChildLimit ? 'childLimit' : 'morePlanning';
}

export type CanonicalCorrectionFinding = {
  summary: string;
  severity: 'High' | 'Medium' | 'Low';
  affectedPhase: string;
  canonicalLocation: string;
  closureCondition: string;
  status: 'open' | 'resolved' | 'deferred';
};

/** Allow one automatic final pass for a single plan-bookkeeping contradiction. */
export function canAutoApplyFinalCanonicalCorrection(findings: CanonicalCorrectionFinding[], alreadyUsed: boolean): boolean {
  if (alreadyUsed) return false;
  const currentOpen = findings.filter(finding => finding.status === 'open'
    && /current|remediation/i.test(finding.affectedPhase));
  if (currentOpen.length !== 1 || currentOpen[0].severity === 'High') return false;
  const finding = currentOpen[0];
  const text = `${finding.summary} ${finding.canonicalLocation} ${finding.closureCondition}`;
  const canonicalBookkeeping = /canonical|status|wording|table|allowlist|completion gate|bookkeeping/i.test(text);
  const designRisk = /security|credential|access control|data loss|concurren|race|durab|migration|database schema/i.test(text);
  return canonicalBookkeeping && !designRisk;
}
