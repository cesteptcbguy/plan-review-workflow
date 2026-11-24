const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('workflow progress labels name the phase and the active agent step', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');

  assert.match(source, /Planning — round \$\{round\} of \$\{total\}/);
  assert.match(source, /Implementation — round \$\{round\} of \$\{total\}/);
  assert.match(source, /Orchestrator is deciding the next step/);
  assert.match(source, /Plan reviewer is checking scope, safety, and completeness/);
  assert.match(source, /Code reviewer is inspecting the working tree and verification results/);
  assert.doesNotMatch(source, /Round \$\{round\}\/\$\{preset\.maxRounds\}: deciding/);
  assert.doesNotMatch(source, /Code round \$\{round\}\/\$\{preset\.maxCodeRounds\}: deciding/);
});
