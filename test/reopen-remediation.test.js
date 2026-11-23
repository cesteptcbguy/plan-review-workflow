const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
