// What differs from a commit, for the head start of a map about a change: which files, and in code which functions are
// new, different or gone. Deterministic (git and the code facts), so Claude doesn't have to work the diff out itself,
// and the CLI's Claude, which has no shell, still knows where to look.
import { execFileSync } from 'node:child_process';
import { commitInfo, createBaseReader, createRepoReader, isSecretPath } from '@illuminate/core';
import { createFactsIndex, diffSymbols, fileExistsIn, isCodeFile, type SymbolFact } from '@illuminate/facts';

export type FileChange = { file: string; what: 'new' | 'changed' | 'deleted'; detail: string };
export type Changes = { commit: string; subject: string | null; files: FileChange[] };

const MAX_NAMES = 8;
const gitList = (root: string, args: string[]): string[] => {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString().split('\u0000').filter(Boolean);
  } catch {
    return [];
  }
};

/** Files that differ between the commit `ref` names and the code as it is now (untracked files count as new). Null when `ref` names no commit. */
export function changesSince(root: string, ref: string): Changes | null {
  const base = createBaseReader(root, ref);
  if (!base) return null;
  const now = createRepoReader(root);
  const found = new Map<string, FileChange['what']>();
  const diff = gitList(base.root, ['diff', '--name-status', '--no-renames', '--relative', '-z', base.commit, '--', '.']);
  for (let i = 0; i + 1 < diff.length; i += 2) found.set(diff[i + 1]!, diff[i] === 'A' ? 'new' : diff[i] === 'D' ? 'deleted' : 'changed');
  for (const f of gitList(base.root, ['ls-files', '--others', '--exclude-standard', '-z'])) found.set(f, 'new');

  const index = createFactsIndex(base.root, fileExistsIn(base.root), now.text);
  // The fields of a type are left out: the type itself is listed when one of them changes.
  const symbols = (file: string, text: string | null): SymbolFact[] => (text === null ? [] : index.extract(file, text).facts.symbols.filter((s) => !s.name.includes('<') && s.kind !== 'property'));
  const names = (label: string, ids: readonly string[]) => (ids.length ? [`${label}: ${ids.slice(0, MAX_NAMES).map((id) => id.slice(id.indexOf('#') + 1)).join(', ')}${ids.length > MAX_NAMES ? `, …and ${ids.length - MAX_NAMES} more` : ''}`] : []);

  const files = [...found]
    .filter(([file]) => !file.startsWith('.illuminate/') && !isSecretPath(file))
    .map(([file, what]): FileChange => {
      if (!isCodeFile(file)) return { file, what, detail: '' };
      const d = diffSymbols(symbols(file, base.text(file)), symbols(file, what === 'deleted' ? null : now.text(file)));
      const changed = [...d.sig, ...d.body];
      return { file, what, detail: [...names('new', d.added), ...names('changed', changed), ...names('removed', d.removed), ...names('renamed', d.renamed.map(([, to]) => to))].join('; ') };
    })
    // Code first: it is what a map is made of.
    .sort((a, b) => Number(isCodeFile(b.file)) - Number(isCodeFile(a.file)) || a.file.localeCompare(b.file));
  return { commit: base.commit, subject: commitInfo(base.root, base.commit).subject, files };
}

/**
 * The head start's section on recent changes: work not committed yet, or (when there is none) what the last commit
 * did. Each says which `since` a map of it would set. Empty outside a git repo, or when nothing differs.
 */
export function recentChanges(root: string): { title: string; lines: string[] } | null {
  const line = (c: FileChange) => `  - ${c.what} ${c.file}${c.detail ? ` (${c.detail})` : ''}`;
  const open = changesSince(root, 'HEAD');
  if (open?.files.length) return { title: `Not committed yet (differences from the last commit, ${open.commit.slice(0, 7)}; a map of these sets \`since\`: "HEAD")`, lines: open.files.map(line) };
  const last = changesSince(root, 'HEAD~1');
  if (last?.files.length) return { title: `Everything is committed. What the last commit changed (a map of it sets \`since\`: "HEAD~1")`, lines: last.files.map(line) };
  return null;
}
