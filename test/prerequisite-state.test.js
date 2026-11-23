const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canAutoApplyFinalCanonicalCorrection,
  isCompletedPrerequisiteState,
  normalizePrerequisitePlanningDecision,
  planningCheckpointInteractionType
} = require('../dist/prerequisite-state.js');

test('planning cannot complete a linked prerequisite workflow', () => {
  assert.equal(normalizePrerequisitePlanningDecision('PREREQUISITE_COMPLETE', true), 'READY_TO_CODE');
  assert.equal(normalizePrerequisitePlanningDecision('READY_TO_CODE', true), 'READY_TO_CODE');
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
