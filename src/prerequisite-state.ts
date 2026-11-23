export type PrerequisiteCompletionState = {
  stage?: string;
  decision?: string;
  acceptanceStatus?: string;
  returnToRunFile?: string;
};

/** Planning may make a prerequisite implementation-ready, but cannot finish it. */
export function normalizePrerequisitePlanningDecision(decision: string, hasWaitingWorkflow: boolean): string {
  return hasWaitingWorkflow && decision === 'PREREQUISITE_COMPLETE' ? 'READY_TO_CODE' : decision;
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
