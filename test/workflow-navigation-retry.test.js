const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const safety = require('../dist/workflow-safety.js');
const prerequisite = require('../dist/prerequisite-state.js');

function method(name, dependencies) {
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
  const asyncStart = source.indexOf(`  private async ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`  private ${name}(`);
  const end = source.indexOf('\n  private ', start + 1);
  const output = ts.transpileModule(`class Harness {${source.slice(start, end)}\n}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  return new Function(...Object.keys(dependencies), `${output}; return Harness.prototype.${name};`)(...Object.values(dependencies));
}

test('split parent navigation works while incomplete prerequisites remain gated', async () => {
  let child = { parentRunId: 'parent', workflowKind: 'split-phase', stage: 'paused' };
  const navigate = method('returnToWaitingWorkflow', {
    fs: { access: async () => {}, readFile: async () => JSON.stringify(child) }, path,
    isCompletedPrerequisiteState: prerequisite.isCompletedPrerequisiteState
  });
  const calls = [];
  const view = { running: false, returnToRunFile: '/runs/parent/run.json', currentRunFile: '/runs/child/run.json', resumeRun: async target => calls.push(target) };
  await navigate.call(view);
  assert.deepEqual(calls, ['/runs/parent/run.json']);
  child = { workflowKind: 'prerequisite', returnToRunFile: '/runs/parent/run.json', stage: 'paused' };
  await assert.rejects(() => navigate.call(view), /not reached verified completion/);
  assert.equal(calls.length, 1);
});

test('failed prerequisite review permits retry; completed unchanged review suppresses repeats', async () => {
  const writes = [];
  const recheck = method('recheckWaitingPrerequisite', {
    fs: { writeFile: async (file, value) => writes.push(JSON.parse(value)) }, path,
    vscode: { workspace: { workspaceFolders: [{ uri: { fsPath: '/repo' } }] } },
    ...safety, ...prerequisite, prerequisiteRepositoryDigest: async () => 'repository-v1'
  });
  const record = { task: 'task', preset: {}, stage: 'waiting_for_prerequisite', decision: 'WAITING_FOR_PREREQUISITE' };
  let starts = 0;
  const view = {
    pendingPrerequisite: { runDir: '/runs/child', record, plan: '## Operator checklist\n1. Open the app.\n2. Inspect the window.', prerequisite: { title: 'Human operator observations', reason: 'Check app', resumeWhen: 'Observed' } },
    start: async () => { starts++; record.stage = starts === 1 ? 'failed' : 'waiting_for_prerequisite'; },
    showWaitingForPrerequisite() {}, setStatus() {}, sendViewState() {}
  };
  const evidence = 'Step 1: PASS — observation: app opened\nStep 2: PASS — observation: window appeared';
  await recheck.call(view, evidence);
  assert.equal(record.lastPrerequisiteSubmission, undefined);
  assert.equal(writes.length, 0);
  await recheck.call(view, evidence);
  assert.equal(starts, 2);
  assert.equal(record.lastPrerequisiteSubmission, evidence);
  view.pendingPrerequisite.record = JSON.parse(JSON.stringify(record));
  await recheck.call(view, evidence);
  assert.equal(starts, 2);
});

test('a completed A recheck never consumes the first B recheck with identical evidence', async () => {
  const recheck = method('recheckWaitingPrerequisite', {
    fs: { writeFile: async () => {} }, path,
    vscode: { workspace: { workspaceFolders: [{ uri: { fsPath: '/repo' } }] } },
    ...safety, ...prerequisite, prerequisiteRepositoryDigest: async () => 'unchanged-repo'
  });
  const a = { title: 'External A', reason: 'Need A', resumeWhen: 'Evidence A' };
  const b = { title: 'External B', reason: 'Need B', resumeWhen: 'Evidence B' };
  const record = { task: 'task', preset: {}, stage: 'waiting_for_prerequisite', decision: 'WAITING_FOR_PREREQUISITE', prerequisite: a };
  let starts = 0;
  const view = {
    pendingPrerequisite: { runDir: '/runs/test', record, plan: '', prerequisite: a },
    start: async () => { starts++; record.prerequisite = b; view.pendingPrerequisite = { ...view.pendingPrerequisite, prerequisite: b }; },
    showWaitingForPrerequisite() {}, setStatus() {}, sendViewState() {}
  };
  await recheck.call(view, 'same evidence');
  assert.equal(starts, 1);
  assert.equal(record.lastPrerequisiteKey, prerequisite.prerequisiteReviewKey(a, ''));
  // Simulate restarting on B with the persisted record from the completed A check.
  view.pendingPrerequisite.record = JSON.parse(JSON.stringify(record));
  await recheck.call(view, 'same evidence');
  assert.equal(starts, 2);
  await recheck.call(view, 'same evidence');
  assert.equal(starts, 2);
});

test('numbered operator checklist creates a visible results interaction and complete template', async () => {
  const show = method('showWaitingForPrerequisite', { path, ...safety });
  const view = { rememberRun() {}, setStatus() {}, sendViewState() {} };
  show.call(view, '/runs/test', { task: 'task', preset: { name: 'test' }, files: [] }, '## Operator checklist\nUse prior O-3 result for context.\n1. Open app.\n2. Inspect window.', undefined, { title: 'Human operator check', reason: 'Need observations', resumeWhen: 'Record both' });
  assert.equal(view.currentInteraction.humanProcedure, true);
  assert.match(view.currentInteraction.responseTemplate, /Step 1: PASS\/FAIL\/UNVERIFIED/);
  assert.match(view.currentInteraction.responseTemplate, /Step 2: PASS\/FAIL\/UNVERIFIED/);
  assert.equal(safety.validatePrerequisiteResults('1. Open app.\n2. Inspect window.', 'Step 1: PASS — observation: opened'), false);
  const elements = new Map();
  const element = () => ({ value: '', hidden: false, textContent: '', replaceChildren() {}, appendChild() {}, querySelectorAll() { return []; } });
  const context = {
    document: { getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'Waiting', checkpointId: 'numbered', interaction: view.currentInteraction, artifacts: [] }) }),
    setInterval() {}, location: {}, confirm: () => true
  };
  const html = require('../dist/mobile.js').dashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  await require('node:vm').runInNewContext(script + ';refresh()', context);
  assert.equal(elements.get('answer').hidden, false);
  assert.match(elements.get('answer').value, /Step 2:/);
  const desktopSource = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
  const desktopHandler = desktopSource.split('\n').find(line => line.includes("m.type==='restore'&&m.interaction?.type==='prerequisitePending'&&m.interaction.humanProcedure"));
  let restore;
  elements.get('answer').hidden = true;
  const desktopElements = new Map();
  require('node:vm').runInNewContext(desktopHandler, {
    window: { addEventListener: (_type, handler) => { restore = handler; } },
    el: id => { if (!desktopElements.has(id)) desktopElements.set(id, element()); return desktopElements.get(id); }
  });
  restore({ data: { type: 'restore', interaction: view.currentInteraction } });
  assert.equal(desktopElements.get('humanInput').hidden, false);
  assert.match(desktopElements.get('humanInput').value, /Step 2:/);
  const repeated = '1. X\n1. Y';
  assert.match(safety.humanPrerequisiteResponseTemplate(repeated), /Step 2:/);
  assert.equal(safety.validatePrerequisiteResults(repeated, 'Step 1: PASS — observation: X'), false);
  assert.equal(safety.validatePrerequisiteResults(repeated, 'Step 1: PASS — observation: X\nStep 2: PASS — observation: Y'), true);
});
