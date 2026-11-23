const assert = require('node:assert/strict');
const test = require('node:test');
const { acceptanceOutcome, completedAcceptanceNeedsReopen, requiresExplicitImplementationApproval, siblingEvidenceSatisfiesProcedure } = require('../dist/workflow-safety.js');

test('an individual failed check overrides an overall PASS claim', () => {
  assert.equal(acceptanceOutcome('Overall acceptance result: PASS\nCheck 1: FAIL — crashes on startup'), 'fail');
  assert.equal(acceptanceOutcome('Overall acceptance result: PASS\nC-1: PASS — opened safely'), 'pass');
  assert.equal(acceptanceOutcome('Overall acceptance result: PASS\n**Check 1:** FAIL — crashes'), 'fail');
  assert.equal(acceptanceOutcome('Overall acceptance result: PASS\nCheck 1: **FAIL** — crashes'), 'fail');
  assert.equal(acceptanceOutcome('Overall acceptance result: PASS\n1. FAIL — crashes'), 'fail');
  assert.equal(completedAcceptanceNeedsReopen('Overall acceptance result: PASS\nCheck 1: **FAIL**'), true);
});

test('sibling evidence must pass every named check and establish that it remains current', () => {
  const procedure = 'Run QA1 and QA2 before accepting this phase.';
  const revision = 'abc1234567890def';
  assert.equal(siblingEvidenceSatisfiesProcedure(procedure, `QA1: PASS\nRevision: ${revision}`, revision), false);
  assert.equal(siblingEvidenceSatisfiesProcedure(procedure, `QA1: PASS\nQA2: NOT RUN\nRevision: ${revision}`, revision), false);
  assert.equal(siblingEvidenceSatisfiesProcedure(procedure, `QA1: PASS; QA2: NOT RUN\nRevision: ${revision}`, revision), false);
  assert.equal(siblingEvidenceSatisfiesProcedure(procedure, `QA1: PASS\nQA2: PASS\nRevision: ${revision}`, revision), true);
  assert.equal(siblingEvidenceSatisfiesProcedure(procedure, 'QA1: PASS\nQA2: PASS', revision), false);
  assert.equal(siblingEvidenceSatisfiesProcedure(procedure, `QA1: PASS\nQA2: FAIL\nRevision: ${revision}`, revision), false);
  assert.equal(siblingEvidenceSatisfiesProcedure(procedure, 'QA1: PASS\nQA2: PASS\nRevision: fff999999999', revision), false);
  assert.equal(siblingEvidenceSatisfiesProcedure(procedure, `QA1: PASS\nRevision: old111111111\n\n---\n\nQA2: PASS\nRevision: ${revision}`, revision), false);
});

test('legacy remediation records retain the explicit implementation approval gate', () => {
  assert.equal(requiresExplicitImplementationApproval({ remediationOfRunId: 'older-run' }), true);
  assert.equal(requiresExplicitImplementationApproval({ implementationRequiresHumanApproval: true }), true);
  assert.equal(requiresExplicitImplementationApproval({}), false);
});
