const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { hasPendingOwnerApproval } = require('../dist/workflow-safety.js');
const { isImplementationApprovalItem, recordOwnerImplementationConsent } = require('../dist/workflow-safety.js');

test('implementation approval is inferred independently from an existing deployment approval', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const start = source.indexOf('function inferPendingAfterPrerequisite(');
  const end = source.indexOf('\nasync function prerequisiteRepositoryDigest', start);
  const helper = source.slice(start, end).replace('record: RunRecord', 'record').replace("): string[] {", ') {');
  const infer = new Function('isImplementationApprovalItem', `${helper}; return inferPendingAfterPrerequisite;`)(isImplementationApprovalItem);
  assert.deepEqual(infer({ originalTask: 'Before production deployment, obtain owner approval.' }), []);
  assert.deepEqual(infer({ originalTask: 'Implementation requires no owner approval.' }), []);
  assert.deepEqual(infer({ originalTask: 'Implement the feature before requesting deployment approval.' }), []);
  assert.ok(infer({ originalTask: 'Plan the feature.' }, 'Implementation requires owner approval.').some(isImplementationApprovalItem));
  assert.deepEqual(infer({ originalTask: 'Plan the feature.' }, 'Open questions: Which provider?'), ['Answer the plan’s open owner questions.']);
  for (const existing of [undefined, [], ['Approve production deployment.']]) {
    const record = { originalTask: 'Write no code until I approve', pendingAfterPrerequisite: existing, prerequisite: { pendingAfter: ['Approve production deployment.'] } };
    record.pendingAfterPrerequisite = infer(record);
    assert.ok(record.pendingAfterPrerequisite.includes('Approve production deployment.'));
    assert.ok(record.pendingAfterPrerequisite.some(isImplementationApprovalItem));
    assert.equal(hasPendingOwnerApproval(record), true);
    recordOwnerImplementationConsent(record, 'I approve implementation');
    record.pendingAfterPrerequisite = infer(record);
    assert.deepEqual(record.pendingAfterPrerequisite, ['Approve production deployment.']);
    assert.equal(hasPendingOwnerApproval(record), false);
  }
});

test('resume repairs stale readiness and persists the approval question before publication', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const start = source.indexOf("    if ((savedDecision?.decision === 'READY_TO_CODE'");
  const end = source.indexOf('    const requirementsBaseline', start);
  assert.ok(start >= 0 && end > start);
  const writes = new Map();
  const raw = { stage: 'ready_to_code', decision: 'READY_TO_CODE', pendingAfterPrerequisite: ['Approve feature implementation.'] };
  const runFile = '/tmp/test-run/run.json';
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('raw', 'savedDecision', 'hasPendingOwnerApproval', 'fs', 'path', 'runDir', 'runFile', 'round', source.slice(start, end) + '\nreturn savedDecision;');
  const decision = await execute(raw, { decision: 'READY_TO_CODE' }, hasPendingOwnerApproval, { writeFile: async (file, contents) => writes.set(file, JSON.parse(contents)) }, path, '/tmp/test-run', runFile, 3);
  assert.equal(decision.decision, 'NEEDS_HUMAN');
  assert.equal(raw.stage, 'waiting_for_human');
  assert.equal(writes.get(runFile).decision, 'NEEDS_HUMAN');
  assert.equal(writes.get('/tmp/test-run/round-3-decision.json').decision, 'NEEDS_HUMAN');
  const prompt = source.indexOf("if (['waiting_for_human', 'deciding'].includes(raw.stage)", end);
  assert.ok(prompt > end && prompt < source.indexOf("if (savedDecision?.decision === 'READY_TO_CODE')", end));
});

test('interrupted approval saves restore the saved question', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const start = source.indexOf("    if (['waiting_for_human', 'deciding'].includes(raw.stage)");
  const end = source.indexOf('    if (isCompletedPrerequisiteState(raw))', start);
  const raw = { stage: 'deciding', codeRound: 7, task: 'task', files: [] };
  const saved = { decision: 'NEEDS_HUMAN', detail: 'Reply I approve implementation' };
  const view = { rememberRun() {}, setStatus() {}, sendViewState() {}, post() {} };
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('raw', 'savedDecision', 'fs', 'runFile', 'runDir', 'round', 'plan', 'review', 'orchestratorDirection', 'preset', 'planningProgress', 'stage', source.slice(start, end).replace('const context: ResumeContext', 'const context'));
  await execute.call(view, raw, saved, { writeFile: async () => {} }, '/tmp/run.json', '/tmp', 1, 'plan', 'review', '', { name: 'preset', maxRounds: 3 }, () => '', undefined);
  assert.equal(view.currentInteraction.type, 'needsInput');
  assert.equal(view.currentInteraction.text, saved.detail);
  assert.equal(raw.stage, 'waiting_for_human');
  assert.match(source, /!\['ready_to_code', 'waiting_for_human', 'deciding', 'planning', 'reviewing'\]\.includes\(raw.stage\) && raw.codeRound/);
});

test('reopening a completed phase requires reviewed planning before implementation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const start = source.indexOf('private async reopenCompletedPhase');
  const end = source.indexOf('private async runFinalVerification', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const implementation = source.slice(start, end);

  assert.match(implementation, /stage: 'planning'/);
  assert.match(implementation, /await this\.start\(remediationTask/);
  assert.match(implementation, /Implementation has not been authorized/);
  assert.match(implementation, /implementationRequiresHumanApproval: true/);
  assert.doesNotMatch(implementation, /await this\.startCode\(/);
  assert.doesNotMatch(implementation, /decision: 'READY_TO_CODE'/);
});

test('automatic secondary approval cannot bypass an explicit remediation implementation gate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  assert.match(source, /autoImplementAfterSecondaryApproval && !requiresExplicitImplementationApproval\(record\)/);
  assert.match(source, /requiresExplicitImplementationApproval\(raw\)/);
});

test('resume reopens completed acceptance when saved evidence now contains a failure', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const start = source.indexOf('private async resumeRun');
  const end = source.indexOf('private async start(', start);
  const implementation = source.slice(start, end);
  assert.match(implementation, /completedAcceptanceNeedsReopen\(savedResults\)/);
  assert.match(implementation, /savedOutcome === 'fail'/);
  assert.match(implementation, /invalidateCompletedPhaseChain/);
});
