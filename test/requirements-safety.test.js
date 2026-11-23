const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeBaseline, reconcileRequirementsBaseline } = require('../dist/requirements.js');

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
  assert.throws(() => reconcileRequirementsBaseline(previous, candidate, []), /exceeding the 80-item safety limit/);
  assert.throws(() => normalizeBaseline({ ...candidate, requirements: [...candidate.requirements, requirement('REQ-081', 'One requirement too many.')] }), /exceeding the 80-item safety limit/);
});
