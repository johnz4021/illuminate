// Saying when a newer illuminate is out: asked of npm at most once a day, said at most once a day, never in a checkout.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkForUpdate, isNewer, updateMessage } from '../src/updates';

const HOUR = 60 * 60 * 1000;
const dirs: string[] = [];
const cacheFile = () => {
  const d = mkdtempSync(join(tmpdir(), 'illuminate-update-'));
  dirs.push(d);
  return join(d, 'nested', 'update-check.json');
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('update check', () => {
  it('compares versions as numbers', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.4.0')).toBe(true);
    expect(isNewer('0.4.0', '0.4.0')).toBe(false);
    expect(isNewer('0.3.9', '0.4.0')).toBe(false);
    expect(isNewer('0.5.0-beta.1', '0.4.0')).toBe(true);
  });

  it('says a newer version once, asks npm at most once a day, and says it again a day later', async () => {
    const file = cacheFile();
    let asked = 0;
    const latest = async () => { asked++; return '0.5.0'; };
    const at = (now: number) => checkForUpdate({ current: '0.4.0', now, cacheFile: file, latest, env: {} });
    expect(await at(0)).toEqual({ current: '0.4.0', latest: '0.5.0' });
    expect(await at(HOUR)).toBeNull(); // said already today
    expect(asked).toBe(1); // and npm wasn't asked again
    expect(await at(25 * HOUR)).toEqual({ current: '0.4.0', latest: '0.5.0' });
    expect(asked).toBe(2);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ latest: '0.5.0', toldVersion: '0.5.0' });
  });

  it('says a version that came out since, even on a day it already said one', async () => {
    const file = cacheFile();
    let version = '0.5.0';
    const at = (now: number) => checkForUpdate({ current: '0.4.0', now, cacheFile: file, latest: async () => version, env: {} });
    expect(await at(0)).not.toBeNull();
    version = '0.6.0';
    expect(await at(2 * HOUR)).toBeNull(); // npm isn't asked again within the day
    expect(await at(25 * HOUR)).toEqual({ current: '0.4.0', latest: '0.6.0' });
  });

  it('stays quiet when up to date, offline, in a checkout, in CI, or when turned off', async () => {
    const latest = async () => '0.5.0';
    expect(await checkForUpdate({ current: '0.5.0', cacheFile: cacheFile(), latest, env: {} })).toBeNull();
    expect(await checkForUpdate({ current: '0.4.0', cacheFile: cacheFile(), latest: async () => { throw new Error('offline'); }, env: {} })).toBeNull();
    expect(await checkForUpdate({ current: undefined, cacheFile: cacheFile(), latest, env: {} })).toBeNull();
    expect(await checkForUpdate({ current: '0.4.0', cacheFile: cacheFile(), latest, env: { CI: 'true' } })).toBeNull();
    expect(await checkForUpdate({ current: '0.4.0', cacheFile: cacheFile(), latest, env: { ILLUMINATE_NO_UPDATE_CHECK: '1' } })).toBeNull();
  });

  it('says how to update the way it was installed, and never to update without asking', () => {
    const n = { current: '0.4.0', latest: '0.5.0' };
    const plugin = updateMessage(n, 'plugin');
    expect(plugin).toContain('claude plugin marketplace update illuminate');
    expect(plugin).toContain('claude plugin update illuminate@illuminate');
    expect(plugin).toContain('only if they say yes');
    expect(plugin).toContain('"Plugin updated"');
    expect(updateMessage(n, 'mcp')).toContain('README');
    expect(updateMessage(n, 'cli')).toBe('A newer illuminate is out (0.5.0; this is 0.4.0). Update with: npm install -g @johnz4021/illuminate');
  });
});
