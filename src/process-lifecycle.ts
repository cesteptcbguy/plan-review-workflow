import { spawn, type ChildProcess } from 'node:child_process';

export type ChildExit = { code: number | null; signal: NodeJS.Signals | null; abortError?: Error };
export type WindowsTreeTerminator = (pid: number, force: boolean) => Promise<void>;
export type ProcessTreeOptions = {
  platform?: NodeJS.Platform;
  windowsTerminator?: WindowsTreeTerminator;
  onTerminationFailure?: (error: Error) => void;
};

export function windowsTaskkillArgs(pid: number, force: boolean): string[] {
  return ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
}

export const runWindowsTaskkill: WindowsTreeTerminator = (pid, force) => new Promise((resolve, reject) => {
  const killer = spawn('taskkill', windowsTaskkillArgs(pid, force), { stdio: 'ignore', windowsHide: true });
  let settled = false;
  killer.once('error', error => {
    if (settled) return;
    settled = true;
    reject(new Error(`taskkill ${force ? '/T /F' : '/T'} could not start: ${error.message}`));
  });
  killer.once('close', code => {
    if (settled) return;
    settled = true;
    if (code === 0) resolve();
    else reject(new Error(`taskkill ${force ? '/T /F' : '/T'} exited with code ${code ?? 'unknown'}.`));
  });
});

function signalPosixTree(child: ChildProcess, signalName: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signalName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    try { child.kill(signalName); } catch { /* The process already exited. */ }
  }
}

function posixTreeIsAlive(child: ChildProcess): boolean {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function waitForChildExit(
  child: ChildProcess,
  signal: AbortSignal,
  forceAfterMs = 5_000,
  options: ProcessTreeOptions = {}
): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    const platform = options.platform ?? process.platform;
    const windowsTerminator = options.windowsTerminator ?? runWindowsTaskkill;
    let settled = false;
    let abortError: Error | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let treePoll: NodeJS.Timeout | undefined;
    let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let windowsPendingAttempts = 0;
    let windowsSuccessfulAttempts = 0;
    let windowsForcedStarted = false;
    let windowsFailureReported = false;
    const windowsErrors: Error[] = [];

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (forceTimer) clearTimeout(forceTimer);
      if (treePoll) clearTimeout(treePoll);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const windowsFailure = () => new Error(`Windows process-tree termination failed. ${windowsErrors.map(error => error.message).join(' ')}`.trim());
    const reportWindowsFailure = () => {
      const exhausted = signal.aborted && platform === 'win32' && windowsForcedStarted
        && windowsPendingAttempts === 0 && windowsSuccessfulAttempts === 0;
      if (!exhausted) return undefined;
      const error = windowsFailure();
      if (!windowsFailureReported) {
        windowsFailureReported = true;
        options.onTerminationFailure?.(error);
      }
      return error;
    };
    const finishAfterTreeExit = () => {
      if (settled) return;
      if (signal.aborted && platform === 'win32') {
        if (windowsPendingAttempts > 0) return;
        const error = reportWindowsFailure();
        if (error) {
          if (closed) fail(error);
          return;
        }
      }
      if (!closed) return;
      if (signal.aborted && platform !== 'win32' && posixTreeIsAlive(child)) {
        treePoll = setTimeout(finishAfterTreeExit, 25);
        treePoll.unref();
        return;
      }
      settled = true;
      cleanup();
      resolve({ ...closed, abortError });
    };
    const startWindowsAttempt = (force: boolean) => {
      if (!child.pid || settled || (force && windowsForcedStarted)) return;
      if (force) windowsForcedStarted = true;
      windowsPendingAttempts += 1;
      void windowsTerminator(child.pid, force)
        .then(() => { windowsSuccessfulAttempts += 1; })
        .catch(error => {
          windowsErrors.push(error instanceof Error ? error : new Error(String(error)));
          if (!force) startWindowsAttempt(true);
        })
        .finally(() => {
          windowsPendingAttempts -= 1;
          finishAfterTreeExit();
        });
    };
    const forceTermination = () => {
      if (forceTimer || settled) return;
      if (platform === 'win32') startWindowsAttempt(false);
      else signalPosixTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => {
        if (settled) return;
        if (platform === 'win32') startWindowsAttempt(true);
        else signalPosixTree(child, 'SIGKILL');
      }, forceAfterMs);
      forceTimer.unref();
    };
    const onAbort = () => {
      abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      forceTermination();
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.on('error', error => {
      if (signal.aborted || error.name === 'AbortError') {
        abortError = error;
        forceTermination();
        return;
      }
      fail(error);
    });
    child.on('close', (code, signalName) => {
      if (settled) return;
      closed = { code, signal: signalName };
      finishAfterTreeExit();
    });
  });
}
