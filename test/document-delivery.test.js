const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyBoundedDocumentDelivery, captureWorktreeBaseline } = require('../dist/document-delivery.js');
const { explicitlyWritablePaths } = require('../dist/document-delivery.js');

test('child delivery authorization comes only from the inherited owner destination list', () => {
  const ownerPaths = explicitlyWritablePaths('Write docs/planning/owner.md.');
  const modelText = 'Write docs/planning/reference.md.';
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
  assert.deepEqual(ownerPaths, ['docs/planning/owner.md']);
  assert.equal(ownerPaths.includes(explicitlyWritablePaths(modelText)[0]), false);
  assert.match(source, /ownerDocumentPaths, workflowKind: 'prerequisite'/);
  assert.match(source, /record\.ownerDocumentPaths \?\? \(record\.workflowKind === 'prerequisite' \? \[\]/);
});

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-delivery-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(cwd, 'doc'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'doc/future-features.md'), 'Existing\nStatus: idea\nUnrelated\n');
  fs.writeFileSync(path.join(cwd, 'unrelated.md'), 'original\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'fixture');
  fs.writeFileSync(path.join(cwd, 'unrelated.md'), 'pre-existing owner edit\n');
  return cwd;
}

test('bounded delivery writes only authorized planning documents and preserves pre-existing changes and the index', async t => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const indexBefore = git(cwd, 'ls-files', '-s');
  const task = 'Write the draft to docs/planning/<slug>/00-<slug>-draft.md. Update doc/future-features.md. Do not commit.';
  const result = await applyBoundedDocumentDelivery(cwd, task, 'Preface\n# Canonical draft\nBody', {
    planDocument: { path: 'docs/planning/milestones/00-milestones-draft.md', startHeading: '# Canonical draft' },
    replacements: [{ path: 'doc/future-features.md', before: 'Status: idea', after: 'Status: exploring' }]
  });
  assert.equal(fs.readFileSync(path.join(cwd, 'docs/planning/milestones/00-milestones-draft.md'), 'utf8'), '# Canonical draft\nBody\n');
  assert.match(fs.readFileSync(path.join(cwd, 'doc/future-features.md'), 'utf8'), /Status: exploring/);
  assert.equal(fs.readFileSync(path.join(cwd, 'unrelated.md'), 'utf8'), 'pre-existing owner edit\n');
  assert.equal(git(cwd, 'ls-files', '-s'), indexBefore);
  assert.deepEqual(result.changedPaths, ['doc/future-features.md', 'docs/planning/milestones/00-milestones-draft.md']);
});

test('bounded delivery rejects undeclared code paths and ambiguous replacements', async t => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await assert.rejects(() => applyBoundedDocumentDelivery(cwd, 'Update doc/future-features.md', 'Plan', {
    planDocument: { path: 'src/main.ts' }
  }), /did not authorize/);
  await assert.rejects(() => applyBoundedDocumentDelivery(cwd, 'Update doc/future-features.md', 'Plan', {
    replacements: [{ path: 'doc/future-features.md', before: 'missing', after: 'new' }]
  }), /expected exactly one match/);
  assert.equal(fs.readFileSync(path.join(cwd, 'doc/future-features.md'), 'utf8'), 'Existing\nStatus: idea\nUnrelated\n');
});

test('mentioning a Markdown file for context does not authorize overwriting it', async t => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(cwd, 'doc/future-features.md'), 'utf8');
  await assert.rejects(() => applyBoundedDocumentDelivery(
    cwd,
    'Use doc/future-features.md as context. This is planning only and writes no code.',
    '# Replacement',
    { planDocument: { path: 'doc/future-features.md' } }
  ), /did not authorize/);
  await assert.rejects(() => applyBoundedDocumentDelivery(
    cwd,
    'Do not update doc/future-features.md; it is reference material only.',
    '# Replacement',
    { planDocument: { path: 'doc/future-features.md' } }
  ), /did not authorize/);
  await assert.rejects(() => applyBoundedDocumentDelivery(
    cwd,
    'Write docs/planning/output.md using doc/future-features.md as context.',
    '# Replacement',
    { planDocument: { path: 'doc/future-features.md' } }
  ), /did not authorize/);
  assert.equal(fs.readFileSync(path.join(cwd, 'doc/future-features.md'), 'utf8'), before);
});

test('bounded delivery refuses to overwrite a dirty target or follow a parent symlink', async t => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'docs/planning/milestones'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'docs/planning/milestones/00-milestones-draft.md'), 'owner draft\n');
  const task = 'Write docs/planning/milestones/00-milestones-draft.md.';
  await assert.rejects(() => applyBoundedDocumentDelivery(cwd, task, '# Replacement', {
    planDocument: { path: './docs/planning/milestones/00-milestones-draft.md' }
  }), /pre-existing working-tree changes/);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(cwd, 'doc/linked'));
  await assert.rejects(() => applyBoundedDocumentDelivery(cwd, 'Write doc/linked/plan.md.', '# Plan', {
    planDocument: { path: 'doc/linked/plan.md' }
  }), /symbolic-link boundary/);
});

test('starting-state capture supports a repository before its first commit', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-unborn-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'new repository\n');
  const baseline = await captureWorktreeBaseline(cwd);
  assert.equal(baseline.head, 'UNBORN');
  assert.deepEqual(baseline.statusPaths, ['README.md']);
});
