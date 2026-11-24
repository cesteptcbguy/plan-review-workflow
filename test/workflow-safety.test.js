const assert = require('node:assert/strict');
const test = require('node:test');
const { validatePrerequisiteResults, hasPendingOwnerApproval } = require('../dist/workflow-safety.js');

test('pending owner approval blocks implementation independently of readiness decisions', () => {
  assert.equal(hasPendingOwnerApproval({ pendingAfterPrerequisite: ['Give explicit owner approval before implementation.'] }), true);
  assert.equal(hasPendingOwnerApproval({ pendingAfterPrerequisite: ['Record documentation results.'] }), false);
});

test('prerequisite results require every current checklist row and filled observations', () => {
  const procedure = 'O-0 and O-3 observations';
  assert.equal(validatePrerequisiteResults(procedure, 'O-0: PASS — observation: visible'), false);
  assert.equal(validatePrerequisiteResults(procedure, 'O-0: PASS — observation: visible\nO-3: PASS — observation:'), false);
  assert.equal(validatePrerequisiteResults(procedure, 'O-0: PASS — observation: visible\nO-3: UNVERIFIED — observation: access unavailable, admin will confirm'), true);
});
const { acceptanceOutcome, completedAcceptanceNeedsReopen, humanPrerequisiteProcedure, humanPrerequisiteResponseTemplate, requiresExplicitImplementationApproval, siblingEvidenceSatisfiesProcedure } = require('../dist/workflow-safety.js');

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

test('human prerequisite instructions and result rows are extracted from the approved plan', () => {
  const plan = `# Plan

## 6. Operator checklist

Do these steps in the signed-in account.

### O-0 — Choose contexts
Record account labels only.

### O-1 — Inspect plugin access
Open the form and cancel without saving.

## 7. Results recording

Record PASS, FAIL, or UNVERIFIED for O-0 and O-1.

## 8. Decision rules

Do not include this section.`;
  const procedure = humanPrerequisiteProcedure(plan, 'Human-owned account observations O-0–O-1');
  assert.match(procedure, /Operator checklist/);
  assert.match(procedure, /Results recording/);
  assert.doesNotMatch(procedure, /Decision rules/);
  assert.equal(humanPrerequisiteResponseTemplate(procedure), [
    'Human prerequisite session',
    'Date:',
    'Account labels (no names, emails, IDs, or secrets): A=; W=; O=',
    '',
    'O-0: PASS/FAIL/UNVERIFIED — observation:',
    'O-1: PASS/FAIL/UNVERIFIED — documented support: ; effective create permission: ; functional: UNTESTED',
    '',
    'Secrets or identifying values recorded: NO',
    'Unavailable evidence / responsible administrator or support role / precise next action:',
  ].join('\n'));
});

test('ordinary prerequisite workflows do not expose an unrelated operator checklist', () => {
  assert.equal(humanPrerequisiteProcedure('## 6. Operator checklist\nO-0', 'Commit the prerequisite phase first.'), '');
  assert.equal(humanPrerequisiteResponseTemplate('No observation identifiers'), '');
});
