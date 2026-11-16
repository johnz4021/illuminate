// The code as it was at a commit, read through git: what a map of a change (`since`) is compared with. Read-only, the
// same rules as the working tree (paths stay inside the repo, secrets are never read, big and binary files are
// skipped), and nothing is checked out or written.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { GitRef, isSafeRelativePath } from './format';
import { MAX_FILE_BYTES, isSecretPath, type ReadResult, type RepoReader } from './repo';

const git = (root: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch {
    return null;
  }
};

/** The full hash `ref` names in the repo at `root`, or null when it names no commit (or this isn't a git repo). */
export function resolveCommit(root: string, ref: string): string | null {
  if (!GitRef.safeParse(ref).success) return null;
  const out = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])?.trim();
  return out && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
}

/** When a commit was made and its first line, for saying what a map is compared with. */
export function commitInfo(root: string, commit: string): { date: string | null; subject: string | null } {
  const out = git(root, ['show', '-s', '--format=%cI%x00%s', '--end-of-options', commit])?.trim();
  if (!out) return { date: null, subject: null };
  const [date, subject] = out.split('\u0000');
  return { date: date || null, subject: subject || null };
}

export type BaseReader = RepoReader & {
  commit: string;
  /** Whether the commit has this file. */
  has(rel: string): boolean;
};

/** A reader over the repo as it was at `ref`, or null when `ref` names no commit here. */
export function createBaseReader(root: string, ref: string): BaseReader | null {
  const realRoot = fs.realpathSync(root);
  const commit = resolveCommit(realRoot, ref);
  if (!commit) return null;
  let files: Set<string> | null = null;
  // Run from `root`, git lists and reads paths relative to it, so a repo inside a bigger checkout works the same.
  const has = (rel: string) => (files ??= new Set((git(realRoot, ['ls-tree', '-r', '--name-only', '-z', commit]) ?? '').split('\u0000').filter(Boolean))).has(rel);
  const cache = new Map<string, ReadResult>();
  const readUncached = (rel: string): ReadResult => {
    if (!isSafeRelativePath(rel)) return { ok: false, reason: 'path is outside the repo' };
    if (isSecretPath(rel)) return { ok: false, reason: 'secret files are never read' };
    if (!has(rel)) return { ok: false, reason: 'file not found' };
    const text = git(realRoot, ['show', `${commit}:./${rel}`]);
    if (text === null) return { ok: false, reason: 'file not found' };
    if (text.length > MAX_FILE_BYTES) return { ok: false, reason: 'file is too large to check' };
    if (text.slice(0, 8000).includes('\u0000')) return { ok: false, reason: 'binary file' };
    return { ok: true, text };
  };
  const read = (rel: string): ReadResult => {
    let hit = cache.get(rel);
    if (!hit) cache.set(rel, (hit = readUncached(rel)));
    return hit;
  };
  return { root: realRoot, commit, has, read, text: (rel) => { const r = read(rel); return r.ok ? r.text : null; } };
}

/**
 * What changed between two versions of some code, as lines: `+` added, `-` removed, two spaces for a line that stayed
 * (a couple are kept around each change), and `…` where unchanged lines were left out. Null when the texts are too
 * long to compare line by line.
 */
export function lineDiff(before: string, after: string, context = 2, max = 60): string[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start;
  const m = endB - start;
  if (n * m > 1_000_000) return null;
  // Longest common subsequence of the middle, then walk it back into a list of kept, removed and added lines.
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[start + i] === b[start + j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: [' ' | '+' | '-', string][] = a.slice(0, start).map((l) => [' ', l]);
  for (let i = 0, j = 0; i < n || j < m; ) {
    if (i < n && j < m && a[start + i] === b[start + j]) { ops.push([' ', a[start + i]!]); i++; j++; }
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push(['-', a[start + i]!]); i++; }
    else { ops.push(['+', b[start + j]!]); j++; }
  }
  for (const l of a.slice(endA)) ops.push([' ', l]);
  const keep = ops.map(() => false);
  ops.forEach(([op], i) => {
    if (op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let skipped = false;
  for (const [i, [op, line]] of ops.entries()) {
    if (!keep[i]) { skipped = true; continue; }
    if (skipped && out.length) out.push('…');
    skipped = false;
    if (out.length >= max) { out.push('…'); break; }
    out.push(`${op === ' ' ? '  ' : `${op} `}${line}`);
  }
  return out;
}
