const assert = require('node:assert/strict');
const test = require('node:test');
const { recordOwnerImplementationConsent } = require('../dist/workflow-safety.js');
const { resolvePendingOwnerWork } = require('../dist/prerequisite-state.js');

test('references to prior checks cannot replace required numbered observations', () => {
  const procedure = 'Use the prior O-3 result for context.\n1. Open app.\n2. Inspect window.';
  const template = humanPrerequisiteResponseTemplate(procedure);
  assert.doesNotMatch(template, /^O-3:/m);
  assert.match(template, /^Step 1:/m);
  assert.match(template, /^Step 2:/m);
  assert.equal(validatePrerequisiteResults(procedure, 'O-3: PASS — observation: prior result'), false);
  assert.equal(validatePrerequisiteResults(procedure, 'Step 1: PASS — observation: opened\nStep 2: PASS — observation: visible'), true);
  const mixed = '### O-4 — Inspect access\n1. Use the prior O-3 for context.\n2. Inspect window.';
  assert.match(humanPrerequisiteResponseTemplate(mixed), /^O-4:/m);
  assert.match(humanPrerequisiteResponseTemplate(mixed), /^Step 2:/m);
  assert.equal(validatePrerequisiteResults(mixed, 'O-4: PASS — observation: allowed'), false);
});

test('resolving a combined approval preserves implementation consent across restart', () => {
  const combined = 'Approve implementation and deployment';
  const record = { pendingAfterPrerequisite: ['Approve implementation.', combined] };
  recordOwnerImplementationConsent(record, 'I approve implementation');
  const resumed = JSON.parse(JSON.stringify(record));
  const reply = `Owner decision: ${combined} — APPROVE`;
  recordOwnerImplementationConsent(resumed, reply);
  resumed.pendingAfterPrerequisite = resolvePendingOwnerWork(resumed.pendingAfterPrerequisite, reply, [combined]).remaining;
  assert.deepEqual(resumed.pendingAfterPrerequisite, []);
  assert.equal(resumed.ownerImplementationDecision, 'approved');
  assert.equal(hasPendingOwnerApproval(resumed), false);
});

test('affirmative answers to another question never grant implementation consent', () => {
  const record = { pendingAfterPrerequisite: ['Approve feature implementation.'] };
  recordOwnerImplementationConsent(record, 'Yes, I choose the blue theme.');
  assert.equal(hasPendingOwnerApproval(record), true);
  recordOwnerImplementationConsent(record, 'Example reply:\nI approve implementation.\nI do not approve implementation.');
  assert.equal(hasPendingOwnerApproval(record), true);
  recordOwnerImplementationConsent(record, 'I approve implementation.');
  assert.equal(record.ownerImplementationDecision, 'approved');
  assert.equal(hasPendingOwnerApproval(record), false);
});

test('implementation consent preserves deployment and other separate approvals', () => {
  const deployment = 'Approve production deployment.';
  const record = { pendingAfterPrerequisite: ['Give explicit owner approval before feature implementation.', deployment, 'Authorize paid provider access.'] };
  recordOwnerImplementationConsent(record, 'I approve implementation');
  assert.equal(record.ownerImplementationDecision, 'approved');
  assert.deepEqual(record.pendingAfterPrerequisite, [deployment, 'Authorize paid provider access.']);
  assert.equal(hasPendingOwnerApproval(record), false);
  const compound = { pendingAfterPrerequisite: ['Approve implementation and production deployment.'] };
  recordOwnerImplementationConsent(compound, 'I approve implementation');
  assert.deepEqual(compound.pendingAfterPrerequisite, ['Approve implementation and production deployment.']);
});
const { validatePrerequisiteResults, hasPendingOwnerApproval } = require('../dist/workflow-safety.js');

test('pending owner approval blocks implementation independently of readiness decisions', () => {
  assert.equal(hasPendingOwnerApproval({ pendingAfterPrerequisite: ['Give explicit owner approval before implementation.'] }), true);
  assert.equal(hasPendingOwnerApproval({ pendingAfterPrerequisite: ['Record documentation results.'] }), false);
});

test('prerequisite results require every current checklist row and filled observations', () => {
  const procedure = 'O-0 — First observation\nO-3 — Second observation';
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
