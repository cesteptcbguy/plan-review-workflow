const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { waitForChildExit, windowsTaskkillArgs } = require('../dist/process-lifecycle.js');

test('Windows cancellation targets the full process tree and force fallback', () => {
  assert.deepEqual(windowsTaskkillArgs(1234, false), ['/PID', '1234', '/T']);
  assert.deepEqual(windowsTaskkillArgs(1234, true), ['/PID', '1234', '/T', '/F']);
});

test('Windows cancellation awaits overlapping graceful and forced attempts', async () => {
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  const attempts = [];
  const terminator = (_pid, force) => new Promise((resolve, reject) => {
    attempts.push(force);
    setTimeout(() => force ? resolve() : reject(new Error('graceful taskkill failed')), force ? 80 : 40);
  });
  const controller = new AbortController();
  const started = Date.now();
  const waiting = waitForChildExit(child, controller.signal, 10, { platform: 'win32', windowsTerminator: terminator });
  controller.abort();
  setTimeout(() => {
    child.exitCode = 1;
    child.emit('close', 1, null);
  }, 20);
  const result = await waiting;
  assert.ok(result.abortError);
  assert.deepEqual(attempts, [false, true]);
  assert.ok(Date.now() - started >= 70, 'the workflow settled before the forced attempt completed');
});

test('Windows cancellation reports failure when every tree termination attempt fails', async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  child.signalCode = null;
  const controller = new AbortController();
  const waiting = waitForChildExit(child, controller.signal, 50, {
    platform: 'win32',
    windowsTerminator: async (_pid, force) => { throw new Error(force ? 'forced taskkill failed' : 'graceful taskkill failed'); }
  });
  controller.abort();
  setTimeout(() => {
    child.exitCode = 1;
    child.emit('close', 1, null);
  }, 10);
  await assert.rejects(waiting, /Windows process-tree termination failed.*graceful taskkill failed.*forced taskkill failed/);
});

test('Windows termination failure is surfaced while ownership remains locked until process exit', async () => {
  const child = new EventEmitter();
  child.pid = 9876;
  child.exitCode = null;
  child.signalCode = null;
  const controller = new AbortController();
  let reported;
  let released = false;
  const waiting = waitForChildExit(child, controller.signal, 50, {
    platform: 'win32',
    windowsTerminator: async (_pid, force) => { throw new Error(force ? 'forced taskkill failed' : 'graceful taskkill failed'); },
    onTerminationFailure: error => { reported = error; }
  });
  waiting.then(() => { released = true; }, () => { released = true; });
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(reported?.message ?? '', /Windows process-tree termination failed/);
  assert.equal(released, false, 'workflow ownership was released while the provider remained alive');
  child.exitCode = 1;
  child.emit('close', 1, null);
  await assert.rejects(waiting, /Windows process-tree termination failed/);
});

test('abort terminates and awaits the provider process tree before settling', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-stop-'));
  const marker = path.join(directory, 'late-write.txt');
  const controller = new AbortController();
  const grandchild = `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'orphan survived'),180);setTimeout(()=>process.exit(0),220);`;
  const script = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script], { detached: process.platform !== 'win32' });
  const exit = waitForChildExit(child, controller.signal, 100);
  setTimeout(() => controller.abort(), 30);
  const result = await exit;
  assert.ok(result.abortError);
  await new Promise(resolve => setTimeout(resolve, 240));
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(directory, { recursive: true, force: true });
});
