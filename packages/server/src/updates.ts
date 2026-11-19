// Saying when a newer illuminate is out. Nothing is ever updated from here: the person (or Claude, if they say yes)
// runs the update. The check asks the npm registry for the latest version at most once a day, sends nothing about the
// person or their code, and is remembered in ~/.cache/illuminate/update-check.json. A newer version is mentioned at
// most once a day. Running from a checkout (no version), in CI, or with ILLUMINATE_NO_UPDATE_CHECK set, it does nothing.
// Claude Code's own plugin auto-update can fetch a new version too; the plugin message covers that case.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

declare const __ILLUMINATE_VERSION__: string | undefined;

/** The published version this is, set by the release build; undefined when running from a checkout. */
export const VERSION: string | undefined = typeof __ILLUMINATE_VERSION__ === 'string' ? __ILLUMINATE_VERSION__ : undefined;

const PACKAGE = '@johnz4021/illuminate';
const DAY = 24 * 60 * 60 * 1000;

export type Newer = { current: string; latest: string };
type Cache = { checkedAt?: number; latest?: string; toldAt?: number; toldVersion?: string };

/** a.b.c compared as numbers; anything after a "-" (a prerelease) is ignored. */
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) => v.split('-')[0]!.split('.').map((n) => Number(n) || 0);
  const [a, b] = [parts(latest), parts(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

async function fromRegistry(): Promise<string | null> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { version?: unknown };
  return typeof body.version === 'string' ? body.version : null;
}

export type UpdateCheckOptions = {
  current?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  cacheFile?: string;
  latest?: () => Promise<string | null>;
};

/**
 * Whether to tell the person a newer version is out: the versions if so, null if not (or if it was said in the last
 * day, or the check can't run). Never throws: a failed check is the same as nothing new.
 */
export async function checkForUpdate(o: UpdateCheckOptions = {}): Promise<Newer | null> {
  const current = 'current' in o ? o.current : VERSION;
  const env = o.env ?? process.env;
  if (!current || env.ILLUMINATE_NO_UPDATE_CHECK || env.CI) return null;
  const now = o.now ?? Date.now();
  const file = o.cacheFile ?? path.join(os.homedir(), '.cache', 'illuminate', 'update-check.json');
  try {
    let cache: Cache = {};
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')) as Cache; } catch { /* first run, or unreadable */ }
    if (!cache.latest || cache.checkedAt === undefined || now - cache.checkedAt > DAY) {
      const latest = await (o.latest ?? fromRegistry)();
      cache = { ...cache, checkedAt: now, ...(latest ? { latest } : {}) };
    }
    const latest = cache.latest;
    const newer = !!latest && isNewer(latest, current);
    const toldRecently = cache.toldVersion === latest && cache.toldAt !== undefined && now - cache.toldAt < DAY;
    if (newer && !toldRecently) cache = { ...cache, toldAt: now, toldVersion: latest };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
    return newer && !toldRecently ? { current, latest: latest! } : null;
  } catch {
    return null;
  }
}

/** How illuminate was installed, which decides how to update it. */
export type InstalledVia = 'plugin' | 'mcp' | 'cli';

/** What Claude is told (in the channel) or what the terminal shows (the CLI). */
export function updateMessage(n: Newer, via: InstalledVia, agent: 'claude-code' | 'codex' = 'claude-code'): string {
  const out = `A newer illuminate is out (${n.latest}; this is ${n.current}).`;
  if (via === 'cli') return `${out} Update with: npm install -g ${PACKAGE}`;
  const tell = 'Mention it to the person in one sentence after what you tell them about the map.';
  if (agent === 'codex') {
    return `${out} ${tell} How to update depends on how they added illuminate to Codex; the README's Codex section says how. Don't change their setup yourself.`;
  }
  if (via === 'mcp') {
    return `${out} ${tell} They added illuminate with \`claude mcp add\`: restarting Claude Code gets the new version if that command uses \`@johnz4021/illuminate@latest\`; otherwise point them at the README's setup without the plugin. Don't change their setup yourself.`;
  }
  return [
    out,
    tell,
    'If Claude Code already said "Plugin updated" for illuminate, they only need to restart Claude Code.',
    'Otherwise offer to run `claude plugin marketplace update illuminate` and then `claude plugin update illuminate@illuminate` for them; run them only if they say yes, then they restart Claude Code.',
    'Also say that turning on auto-update (/plugin, then Marketplaces, illuminate, Enable auto-update) does this by itself next time.',
  ].join(' ');
}
