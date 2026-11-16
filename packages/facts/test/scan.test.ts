// Listing a repo's files: in git, what git tracks or would track; elsewhere, a walk of the folder.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listRepoFiles } from '../src/scan';

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'illuminate-scan-'));
  tmp.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const FILES = {
  'src/app.ts': 'export const a = 1;\n',
  'venv/lib/site.py': 'x = 1\n',
  'generated/big.ts': 'export const g = 1;\n',
  'node_modules/dep/index.js': 'module.exports = 1;\n',
  'dist/app.js': 'var a = 1;\n',
};

describe('listRepoFiles', () => {
  it('walks a folder that is not in git, leaving out installed packages and build output', () => {
    expect(listRepoFiles(repo(FILES))).toEqual(['generated/big.ts', 'src/app.ts']);
  });

  it('in a git repo, leaves out what .gitignore names and keeps new files not yet committed', () => {
    const dir = repo({ ...FILES, '.gitignore': 'generated/\n' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.gitignore', 'src/app.ts'], { cwd: dir });
    writeFileSync(join(dir, 'src/new.ts'), 'export const n = 1;\n');
    expect(listRepoFiles(dir)).toEqual(['.gitignore', 'src/app.ts', 'src/new.ts']);
  });

  it('leaves out a tracked file that was deleted, and node_modules even when it is committed', () => {
    const dir = repo({ 'src/app.ts': 'export const a = 1;\n', 'src/gone.ts': 'export const b = 1;\n', 'node_modules/dep/index.js': 'module.exports = 1;\n' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-f', '.'], { cwd: dir });
    rmSync(join(dir, 'src/gone.ts'));
    expect(listRepoFiles(dir)).toEqual(['src/app.ts']);
  });
});
