const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('capacity failures offer same-run approved-source recovery without approving the generated baseline', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '..', 'src', 'mobile.ts'), 'utf8');

  assert.match(source, /requirementsFallback/);
  assert.match(source, /Continue from approved source without generated baseline/);
  assert.match(source, /continueWithoutGeneratedBaseline/);
  assert.match(source, /if \(this\.controller\?\.signal\.aborted\) throw error;[\s\S]*handleRequirementsExtractionFailure/);
  assert.match(source, /failureKind: capacityError \? 'capacity' :/);
  assert.match(source, /Status: Rejected generated candidate/);
  assert.match(source, /No requirement was truncated or approved/);
  assert.match(source, /parseLockedCorrectionsMarkdown/);
  assert.match(source, /Source-traceable locked corrections preserved from the failed extraction review/);
  assert.match(source, /status: 'declined'/);
  assert.match(source, /requirementsGuard: false/);
  assert.match(source, /record\.preset = \{ \.\.\.record\.preset, requirementsGuard: false \}/);
  assert.match(source, /raw\.stage === 'requirements_fallback_available'/);
  assert.match(source, /ensureRequirementsFailureEvidence\(runDir, raw, requirementsResume\)/);
  assert.match(source, /if \(raw\.preset\.secondarySolApproval\)[\s\S]*recordDeclinedRequirements[\s\S]*this\.start\(raw\.task, raw\.preset/);
  assert.match(mobile, /continueWithoutGeneratedBaseline/);
});

test('a capacity fallback cannot be approved accidentally or restart extraction after decline', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  assert.match(source, /requirementsGuard\?\.failureKind[\s\S]*cannot be approved/);
  assert.match(source, /record\.requirementsGuard = \{ \.\.\.record\.requirementsGuard!, status: 'declined'/);
  assert.match(source, /if \(preset\.requirementsGuard && record\.requirementsGuard\?\.status !== 'approved'\)/);
  assert.match(source, /record\.preset = \{ \.\.\.record\.preset, requirementsGuard: false \}/);
});
