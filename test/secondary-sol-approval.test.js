const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('selectable secondary approval covers requirements, plan, and implementation checkpoints', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');

  assert.match(source, /id="secondarySolApproval" type="checkbox"/);
  assert.match(source, /id="secondaryApprovalModel" list="codexModels"/);
  assert.match(source, /id="secondaryDecisionDelegation" type="checkbox"/);
  assert.match(source, /secondaryApprovalModel \|\| 'gpt-6\.1-sol'/);
  assert.match(source, /requirements-secondary-approval-review-\$\{reviewNumber\}\.json/);
  assert.match(source, /secondaryAttempt < 2/);
  assert.match(source, /optional local baseline was abandoned instead of asking the owner to repair generated output/);
  assert.match(source, /recordDeclinedRequirements\(runDir, record, resume, reason\)/);
  assert.match(source, /raw\.stage === 'waiting_for_requirements_approval'[\s\S]*raw\.preset\.secondarySolApproval[\s\S]*prepareRequirementsGuard\(runDir, raw, requirementsResume\)/);
  assert.match(source, /round-\$\{round\}-secondary-approval-review\.json/);
  assert.match(source, /code-round-\$\{round\}-secondary-approval-review\.json/);
  assert.match(source, /approved the requirements baseline\. Continuing directly into planning/);
  assert.match(source, /delegatedDecisionPrompt/);
  assert.match(source, /Do not invent a product preference or new requirement/);
  assert.match(source, /approving a bounded plan or operator checklist/);
  assert.match(source, /preserving a later human checkpoint for the actual actions and evidence/);
  assert.match(source, /Do not circularly require an earlier owner approval/);
  assert.match(source, /UI\/device\/native session/);
  assert.match(source, /function requiresDirectHumanAction/);
  assert.match(source, /COMMAND_BLOCKED\|password\|passcode\|secret\|credential/);
  assert.match(source, /autoImplementAfterSecondaryApproval/);
  assert.match(source, /await this\.startCode\(runDir, record, latestPlan\)/);
  assert.match(source, /secondaryCodeApprovalStatus = 'pending'/);
  assert.match(source, /secondaryCodeApprovalStatus = 'approved'/);
  assert.match(source, /secondaryCodeApprovalMissing/);
});
