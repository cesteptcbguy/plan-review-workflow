const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canAutoApplyFinalCanonicalCorrection,
  attachPrerequisiteReport,
  inferWorkflowPurpose,
  isCompletedPrerequisiteState,
  normalizePrerequisitePlanningDecision,
  parentOutcomeAfterPrerequisite,
  planningCheckpointInteractionType,
  prerequisiteEvidenceChanged,
  prerequisitePublicationPrefix,
  resolvePendingOwnerWork
} = require('../dist/prerequisite-state.js');

test('prerequisite completion respects the explicit workflow purpose', () => {
  assert.equal(normalizePrerequisitePlanningDecision('PREREQUISITE_COMPLETE', { hasWaitingWorkflow: true, purpose: 'implementation' }), 'READY_TO_CODE');
  assert.equal(normalizePrerequisitePlanningDecision('PREREQUISITE_COMPLETE', { hasWaitingWorkflow: true, purpose: 'planning-document-delivery' }), 'PREREQUISITE_COMPLETE');
  assert.equal(normalizePrerequisitePlanningDecision('PREREQUISITE_COMPLETE', { hasWaitingWorkflow: true, purpose: 'verification' }), 'PREREQUISITE_COMPLETE');
  assert.equal(normalizePrerequisitePlanningDecision('READY_TO_CODE', { hasWaitingWorkflow: true, purpose: 'verification' }), 'READY_TO_CODE');
});

test('prerequisite hierarchy has stable publication identifiers without becoming a split phase', () => {
  assert.equal(prerequisitePublicationPrefix(undefined, [1]), '00-p01');
  assert.equal(prerequisitePublicationPrefix([2], [1, 2]), '02-p01-p02');
  assert.equal(prerequisitePublicationPrefix([2, 3], undefined), '02-03');
  assert.equal(inferWorkflowPurpose('Write-enabled planning-document delivery for the saved draft and backlog'), 'planning-document-delivery');
  assert.equal(inferWorkflowPurpose('Read-only verification and evidence handoff'), 'verification');
});

test('prerequisite reports attach idempotently', () => {
  const report = { reportId: 'child:abc', sourceRunId: 'child', completedAt: '2026-11-24T00:00:00Z', purpose: 'verification', outcome: 'complete', summary: 'Passed', evidencePaths: ['/tmp/evidence'], digest: 'abc' };
  const first = attachPrerequisiteReport([], report);
  assert.equal(first.added, true);
  const repeated = attachPrerequisiteReport(first.reports, report);
  assert.equal(repeated.added, false);
  assert.equal(repeated.reports.length, 1);
});

test('incident regression: completing a planning-document prerequisite does not complete its parent', () => {
  assert.equal(parentOutcomeAfterPrerequisite([
    'Answer the plan open questions.',
    'Give explicit owner approval before implementation.'
  ]), 'needs-owner-input');
  assert.equal(parentOutcomeAfterPrerequisite([]), 'resume-parent-work');
});

test('owner replies resolve only exact pending work explicitly claimed by review', () => {
  const pending = [
    'Answer the plan’s open owner questions.',
    'Give explicit owner approval before feature implementation.'
  ];
  assert.deepEqual(resolvePendingOwnerWork(pending, 'I approve feature implementation.', [pending[1]]), {
    remaining: pending,
    resolved: []
  });
  assert.deepEqual(resolvePendingOwnerWork(pending, 'I approve implementation.', pending), { remaining: pending, resolved: [] });
  const deployment = 'Approve production deployment.';
  const deferredDeployment = 'Approve deployment at a later date.';
  assert.deepEqual(resolvePendingOwnerWork([deferredDeployment], `Owner decision: ${deferredDeployment} — APPROVE`, [deferredDeployment]), { remaining: [], resolved: [deferredDeployment] });
  assert.deepEqual(resolvePendingOwnerWork([deployment], `Owner decision: ${deployment} — APPROVE`, [deployment]), { remaining: [], resolved: [deployment] });
  assert.deepEqual(resolvePendingOwnerWork(pending, `Resolved owner item: ${pending[0]} — answer: I choose the blue theme.`, [pending[0]]), { remaining: [pending[1]], resolved: [pending[0]] });
  assert.deepEqual(resolvePendingOwnerWork(pending, 'Approval is still pending.', pending), {
    remaining: pending,
    resolved: []
  });
  assert.deepEqual(resolvePendingOwnerWork(pending, 'Here is a partial reply.', pending), {
    remaining: pending,
    resolved: []
  });
  assert.deepEqual(resolvePendingOwnerWork(pending, 'I approve the work.', ['Different pending item']), {
    remaining: pending,
    resolved: []
  });
});

test('ordinary split phases remain independent of prerequisite outcomes', () => {
  assert.equal(normalizePrerequisitePlanningDecision('READY_TO_CODE', { hasWaitingWorkflow: false, purpose: 'implementation' }), 'READY_TO_CODE');
  assert.equal(normalizePrerequisitePlanningDecision('PHASE_COMPLETE', { hasWaitingWorkflow: false, purpose: 'implementation' }), 'PHASE_COMPLETE');
});

test('an unchanged prerequisite submission does not warrant another review', () => {
  assert.equal(prerequisiteEvidenceChanged('same', 'repo-a', 'same', 'repo-a'), false);
  assert.equal(prerequisiteEvidenceChanged('same', 'repo-a', 'new evidence', 'repo-a'), true);
  assert.equal(prerequisiteEvidenceChanged('same', 'repo-a', 'same', 'repo-b'), true);
});

test('one non-High canonical bookkeeping contradiction gets one automatic final pass', () => {
  const statusFinding = [{
    summary: 'The final git status table contradicts a preserve-only file.',
    severity: 'Medium',
    affectedPhase: 'current remediation',
    canonicalLocation: 'completion status rule',
    closureCondition: 'Separate the status set from the authorization allowlist.',
    status: 'open'
  }];
  assert.equal(canAutoApplyFinalCanonicalCorrection(statusFinding, false), true);
  assert.equal(canAutoApplyFinalCanonicalCorrection(statusFinding, true), false);
  assert.equal(canAutoApplyFinalCanonicalCorrection([{ ...statusFinding[0], severity: 'High' }], false), false);
  assert.equal(canAutoApplyFinalCanonicalCorrection([{ ...statusFinding[0], summary: 'Concurrency race in answer settlement', canonicalLocation: 'state design' }], false), false);
});

test('requirements review limit keeps the human-guidance continuation available', () => {
  assert.equal(planningCheckpointInteractionType(false), 'morePlanning');
  assert.equal(planningCheckpointInteractionType(true), 'childLimit');
});

test('return wording has no effect without completed structured state', () => {
  const misleadingDetails = [
    'Return to the saved workflow only after a newly recorded PASS.',
    'Do not return to the waiting workflow yet.',
    'Implementation permits return to the parent after acceptance.',
    'The prerequisite may now resume after the remaining work is complete.'
  ];

  for (const detail of misleadingDetails) {
    const record = {
      returnToRunFile: '/tmp/waiting/run.json',
      stage: 'ready_to_code',
      decision: 'READY_TO_CODE',
      acceptanceStatus: 'pending',
      detail
    };
    assert.equal(isCompletedPrerequisiteState(record), false, detail);
  }
});

test('completion requires every post-code completion field', () => {
  const complete = {
    returnToRunFile: '/tmp/waiting/run.json',
    stage: 'prerequisite_complete',
    decision: 'PREREQUISITE_COMPLETE',
    acceptanceStatus: 'complete'
  };
  assert.equal(isCompletedPrerequisiteState(complete), true);
  assert.equal(isCompletedPrerequisiteState({ ...complete, acceptanceStatus: 'pending' }), false);
  assert.equal(isCompletedPrerequisiteState({ ...complete, stage: 'ready_to_code' }), false);
  assert.equal(isCompletedPrerequisiteState({ ...complete, decision: 'READY_TO_CODE' }), false);
  assert.equal(isCompletedPrerequisiteState({ ...complete, returnToRunFile: undefined }), false);
});
