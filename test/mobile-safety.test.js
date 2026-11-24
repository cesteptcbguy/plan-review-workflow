const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { allowedActions, dashboardHtml, MobileBridge } = require('../dist/mobile.js');

test('phone dashboard permits roadmap acceptance', () => {
  assert.equal(allowedActions.has('acceptRoadmap'), true);
  assert.equal(allowedActions.has('continueWithoutGeneratedBaseline'), true);
});

test('phone dashboard exposes and validates human prerequisite results', () => {
  const html = dashboardHtml();
  const extensionSource = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
  assert.match(html, /humanPrerequisite=i\.type==='prerequisitePending'&&i\.humanProcedure/);
  assert.match(html, /Complete the prerequisite results before rechecking/);
  assert.match(html, /Record results and recheck prerequisite/);
  assert.match(html, /if\(humanPrerequisite&&type==='startPrerequisiteWorkflow'\)continue/);
  assert.match(extensionSource, /procedure && !validatePrerequisiteResults\(procedure, submission\)/);
  assert.match(html, /nextCheckpointKey!==checkpointKey/);
});

test('explicitly stopping a rate-limited tunnel suppresses automatic retry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-tunnel-'));
  const command = path.join(directory, 'fake-devtunnel');
  fs.writeFileSync(command, '#!/usr/bin/env node\nconsole.error("rate limit exceeded");setTimeout(()=>process.exit(1),100);\n');
  fs.chmodSync(command, 0o755);
  const bridge = new MobileBridge({ enabled: true, ntfyServer: 'https://ntfy.sh', ntfyTopic: 'test' }, async () => {}, () => {});
  bridge.server = { close() {} };
  bridge.port = 41731;
  await bridge.startTunnel(command);
  await new Promise(resolve => setTimeout(resolve, 30));
  bridge.stopTunnel();
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(bridge.info().tunnelActive, false);
  assert.equal(bridge.info().tunnelStatus, 'Phone dashboard is stopped.');
  bridge.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
});
