import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DocumentReplacement = { path: string; before: string; after: string };
export type DocumentDelivery = {
  planDocument?: { path: string; startHeading?: string };
  replacements?: DocumentReplacement[];
};

export type WorktreeBaseline = {
  head: string;
  indexDigest: string;
  statusDigest: string;
  dirtyPaths: Record<string, string>;
  statusPaths: string[];
};

export type DocumentDeliveryResult = {
  changedPaths: string[];
  baseline: WorktreeBaseline;
  finalStatusPaths: string[];
};

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function git(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'buffer', maxBuffer: 20_000_000 });
  return stdout as Buffer;
}

async function gitHead(cwd: string): Promise<string> {
  try { return (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).toString('utf8').trim(); }
  catch { return 'UNBORN'; }
}

function statusPaths(raw: Buffer): string[] {
  const fields = raw.toString('utf8').split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const status = field.slice(0, 2);
    const file = field.slice(3);
    if (file) paths.push(file);
    if (/[RC]/.test(status) && fields[index + 1]) paths.push(fields[++index]);
  }
  return [...new Set(paths)].sort();
}

async function contentDigest(cwd: string, relative: string): Promise<string> {
  const file = path.resolve(cwd, relative);
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return `symlink:${await fs.readlink(file)}`;
    if (!stat.isFile()) return `other:${stat.mode}`;
    return `file:${digest(await fs.readFile(file))}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

export async function captureWorktreeBaseline(cwd: string): Promise<WorktreeBaseline> {
  const [head, index, status] = await Promise.all([
    gitHead(cwd),
    git(cwd, ['ls-files', '-s', '-z']),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  const paths = statusPaths(status).filter(file => !file.startsWith('.review-workflow/'));
  const dirtyPaths = Object.fromEntries(await Promise.all(paths.map(async file => [file, await contentDigest(cwd, file)])));
  return {
    head,
    indexDigest: digest(index),
    statusDigest: digest(JSON.stringify({ paths, dirtyPaths })),
    dirtyPaths,
    statusPaths: paths,
  };
}

function canonicalRelativePath(relative: string): string {
  const portable = relative.replace(/\\/g, '/');
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Document-delivery path must stay workspace-relative: ${relative || '<empty>'}`);
  }
  return normalized;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function explicitlyWritablePaths(task: string): string[] {
  // Only this owner-entered field grants delivery authority. Prose references
  // (including "write a summary of ...") cannot become destinations.
  return [...task.matchAll(/^Write destination:\s*`?((?:doc|docs)\/[A-Za-z0-9_./<>-]+\.md)`?\s*$/gim)]
    .map(match => match[1]);
}

export function isAuthorizedPlanningDocument(task: string, relative: string): boolean {
  let normalized: string;
  try { normalized = canonicalRelativePath(relative); }
  catch { return false; }
  if (!/^(?:doc|docs)\/.+\.md$/i.test(normalized)) return false;
  return explicitlyWritablePaths(task).some(candidate => {
    if (!candidate.includes('<')) {
      try { return canonicalRelativePath(candidate) === normalized; }
      catch { return false; }
    }
    const pattern = candidate.split(/(<[^>]+>)/g)
      .map(part => /^<[^>]+>$/.test(part) ? '[^/]+' : escapePattern(part))
      .join('');
    return new RegExp(`^${pattern}$`, 'i').test(normalized);
  });
}

async function validateTarget(cwd: string, task: string, relative: string): Promise<{ relative: string; target: string }> {
  if (!relative || path.isAbsolute(relative)) throw new Error(`Document-delivery path must be workspace-relative: ${relative || '<empty>'}`);
  const normalized = canonicalRelativePath(relative);
  const root = path.resolve(cwd);
  const target = path.resolve(root, normalized);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error(`Document-delivery path escapes the workspace: ${relative}`);
  if (!isAuthorizedPlanningDocument(task, normalized)) throw new Error(`The original task did not authorize planning-document delivery to ${relative}.`);
  const realRoot = await fs.realpath(root);
  let existingParent = path.dirname(target);
  while (existingParent !== root) {
    try { await fs.lstat(existingParent); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      existingParent = path.dirname(existingParent);
    }
  }
  const realParent = await fs.realpath(existingParent);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) throw new Error(`Document-delivery path crosses a symbolic-link boundary: ${relative}`);
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link: ${relative}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { relative: normalized, target };
}

export async function applyBoundedDocumentDelivery(cwd: string, task: string, plan: string, delivery: DocumentDelivery): Promise<DocumentDeliveryResult> {
  const requestedOperations = [
    ...(delivery.planDocument ? [{ kind: 'plan' as const, ...delivery.planDocument }] : []),
    ...(delivery.replacements ?? []).map(item => ({ kind: 'replace' as const, ...item })),
  ];
  if (!requestedOperations.length) throw new Error('Document delivery did not contain an authorized write or replacement.');
  const targets = new Map<string, string>();
  const operations = [] as Array<(typeof requestedOperations)[number]>;
  for (const operation of requestedOperations) {
    const validated = await validateTarget(cwd, task, operation.path);
    operations.push({ ...operation, path: validated.relative });
    targets.set(validated.relative, validated.target);
  }
  const baseline = await captureWorktreeBaseline(cwd);
  for (const operation of operations) {
    if (operation.kind === 'plan' && baseline.statusPaths.includes(operation.path)) {
      throw new Error(`Refusing to overwrite a planning document with pre-existing working-tree changes: ${operation.path}`);
    }
  }
  const backups = new Map<string, Buffer | undefined>();
  for (const [relative, target] of targets) {
    try { backups.set(relative, await fs.readFile(target)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') backups.set(relative, undefined); else throw error; }
  }
  try {
    for (const operation of operations) {
      const target = targets.get(operation.path)!;
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (operation.kind === 'plan') {
        const start = operation.startHeading ? plan.indexOf(operation.startHeading) : 0;
        if (start < 0) throw new Error(`The approved plan does not contain the authorized delivery heading: ${operation.startHeading}`);
        await fs.writeFile(target, `${plan.slice(start).trim()}\n`, 'utf8');
      } else {
        if (!operation.before) throw new Error(`Replacement for ${operation.path} has an empty match string.`);
        const current = await fs.readFile(target, 'utf8');
        const occurrences = current.split(operation.before).length - 1;
        if (occurrences !== 1) throw new Error(`Replacement for ${operation.path} expected exactly one match but found ${occurrences}.`);
        await fs.writeFile(target, current.replace(operation.before, () => operation.after), 'utf8');
      }
    }
    const after = await captureWorktreeBaseline(cwd);
    if (after.head !== baseline.head) throw new Error('Document delivery changed the repository revision.');
    if (after.indexDigest !== baseline.indexDigest) throw new Error('Document delivery changed the human-owned Git index.');
    const authorized = new Set(targets.keys());
    for (const [file, beforeDigest] of Object.entries(baseline.dirtyPaths)) {
      if (!authorized.has(file) && await contentDigest(cwd, file) !== beforeDigest) throw new Error(`Document delivery changed an unrelated pre-existing path: ${file}`);
    }
    for (const file of after.statusPaths) {
      if (!baseline.statusPaths.includes(file) && !authorized.has(file)) throw new Error(`Document delivery introduced an undeclared path: ${file}`);
    }
    return { changedPaths: [...authorized].sort(), baseline, finalStatusPaths: after.statusPaths };
  } catch (error) {
    for (const [relative, before] of backups) {
      const target = targets.get(relative)!;
      if (before === undefined) await fs.rm(target, { force: true });
      else await fs.writeFile(target, before);
    }
    throw error;
  }
}
