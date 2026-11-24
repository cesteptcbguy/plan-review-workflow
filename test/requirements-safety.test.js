const assert = require('node:assert/strict');
const test = require('node:test');
const { RequirementsCapacityError, normalizeBaseline, parseLockedCorrectionsMarkdown, reconcileRequirementsBaseline } = require('../dist/requirements.js');

const requirement = (id, text) => ({ id, text, source: 'approved specification', kind: 'constraint', required: true, owningPhase: 'Phase 0' });
const baseline = requirements => ({ version: 2, scope: 'test', requirements, lockedCorrections: [], approvedTechnologies: [], packageManager: '', requiredMilestones: [], deferred: [] });

test('opposite requirement polarity is never treated as preservation', () => {
  const previous = baseline([requirement('REQ-001', 'The application must not store passwords in plaintext.')]);
  const candidate = baseline([requirement('REQ-001', 'The application must store passwords in plaintext.')]);
  const result = reconcileRequirementsBaseline(previous, candidate, []);
  assert.equal(result.preservedRequirements, 1);
  assert.equal(result.baseline.requirements.length, 2);
  const shallPrevious = baseline([requirement('REQ-001', 'The application shall not store passwords in plaintext.')]);
  const shallCandidate = baseline([requirement('REQ-001', 'The application shall store passwords in plaintext.')]);
  const shallResult = reconcileRequirementsBaseline(shallPrevious, shallCandidate, []);
  assert.equal(shallResult.preservedRequirements, 1);
  assert.equal(shallResult.baseline.requirements.length, 2);
  const compoundPrevious = baseline([requirement('REQ-001', 'Must not log passwords and must store passwords securely.')]);
  const compoundCandidate = baseline([requirement('REQ-001', 'Must log passwords and must not store passwords securely.')]);
  const compoundResult = reconcileRequirementsBaseline(compoundPrevious, compoundCandidate, []);
  assert.equal(compoundResult.preservedRequirements, 1);
  assert.equal(compoundResult.baseline.requirements.length, 2);
});

test('requirements overflow fails instead of silently dropping preserved requirements', () => {
  const previous = baseline([requirement('REQ-001', 'Preserve the original security boundary.')]);
  const candidate = baseline(Array.from({ length: 80 }, (_, index) => requirement(`REQ-${index + 1}`, `Candidate requirement number ${index + 1}.`)));
  assert.throws(() => reconcileRequirementsBaseline(previous, candidate, []), error => {
    assert.equal(error instanceof RequirementsCapacityError, true);
    assert.equal(error.operation, 'reconciliation');
    assert.equal(error.requirementCount, 81);
    assert.equal(error.candidate.requirements.length, 81);
    return true;
  });
  assert.throws(() => normalizeBaseline({ ...candidate, requirements: [...candidate.requirements, requirement('REQ-081', 'One requirement too many.')] }), error => {
    assert.equal(error instanceof RequirementsCapacityError, true);
    assert.equal(error.operation, 'extraction');
    assert.equal(error.requirementCount, 81);
    assert.equal(error.candidate.requirements.length, 81);
    return true;
  });
});

test('unapproved extraction mistakes are superseded while authoritative corrections remain locked', () => {
  const rejected = baseline([
    requirement('REQ-001', 'O-6(d) must be declared verified.'),
    requirement('REQ-002', 'The workflow must require manual implementation approval.')
  ]);
  rejected.approvedTechnologies = ['Rejected Tool'];
  rejected.packageManager = 'rejected-pm';
  rejected.requiredMilestones = ['Rejected generated milestone'];
  rejected.deferred = ['Rejected generated deferral'];
  const corrected = baseline([
    requirement('REQ-001', 'O-6(d) must remain unverified and must not be declared verified.'),
    requirement('REQ-002', 'Secondary approval may authorize automatic implementation.')
  ]);
  const corrections = [{ createdAt: '2026-11-24T00:00:00Z', text: 'O-6(d) must remain unverified and must not be declared verified. Secondary approval may authorize automatic implementation.' }];
  const result = reconcileRequirementsBaseline(rejected, corrected, corrections, { preservePreviousRequirements: false });
  assert.equal(result.preservedRequirements, 0);
  assert.equal(result.baseline.requirements.some(item => /must be declared verified/i.test(item.text)), false);
  assert.equal(result.baseline.requirements.some(item => /automatic implementation/i.test(item.text)), true);
  assert.equal(result.baseline.lockedCorrections.length, 1);
  assert.match(result.baseline.lockedCorrections[0].text, /must remain unverified/);
  assert.deepEqual(result.baseline.approvedTechnologies, []);
  assert.equal(result.baseline.packageManager, '');
  assert.deepEqual(result.baseline.requiredMilestones, []);
  assert.deepEqual(result.baseline.deferred, []);
});

test('an approved prior baseline can still be preserved explicitly', () => {
  const approved = baseline([requirement('REQ-001', 'Preserve the approved owner decision.')]);
  const candidate = baseline([requirement('REQ-001', 'Add the new current-scope behavior.')]);
  const result = reconcileRequirementsBaseline(approved, candidate, [], { preservePreviousRequirements: true });
  assert.equal(result.preservedRequirements, 1);
  assert.equal(result.baseline.requirements.length, 2);
});

test('locked corrections can be recovered from a failed run artifact', () => {
  const corrections = parseLockedCorrectionsMarkdown(`# Locked requirements corrections

## LOCK-001

Recorded: 2026-11-24T17:46:21.885Z

O-6(d) must remain unverified.

## LOCK-002

Recorded: 2026-11-24T17:47:00.000Z

Secondary plan approval authorizes automatic implementation.
`);
  assert.deepEqual(corrections, [
    { createdAt: '2026-11-24T17:46:21.885Z', text: 'O-6(d) must remain unverified.' },
    { createdAt: '2026-11-24T17:47:00.000Z', text: 'Secondary plan approval authorizes automatic implementation.' }
  ]);
});
