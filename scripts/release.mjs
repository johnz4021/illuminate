// Builds the publishable npm package in release/: the server, core and facts bundled into one file (release/dist), the
// built viewer (release/viewer), README and LICENSE. Third-party packages stay normal dependencies, pinned to the
// versions the workspaces use, so npm installs the right per-platform parser builds.
//   node scripts/release.mjs          build release/
//   cd release && npm pack            try the package
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

// Every runtime dependency of the bundled workspaces, except the workspaces themselves and tsx (only the dev bin uses it).
const deps = {};
for (const ws of ['facts', 'core', 'server']) {
  for (const [name, version] of Object.entries(read(`packages/${ws}/package.json`).dependencies ?? {})) {
    if (name.startsWith('@illuminate/') || name === 'tsx') continue;
    if (deps[name] && deps[name] !== version) throw new Error(`${name} is pinned to ${deps[name]} and ${version}`);
    deps[name] = version;
  }
}

const version = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).version;
execSync('npm run build', { cwd: root, stdio: 'inherit' });
fs.rmSync(path.join(out, 'dist'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'viewer'), { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, 'packages/server/src/cli.ts')],
  outfile: path.join(out, 'dist/cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: Object.keys(deps).flatMap((d) => [d, `${d}/*`]),
  // Bundled ESM still meets packages that call require(); give it one.
  banner: { js: "import { createRequire as __illuminateRequire } from 'node:module'; const require = __illuminateRequire(import.meta.url);" },
  // The version the server reports, and compares with npm's latest to say when an update is out (updates.ts).
  define: { __ILLUMINATE_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
});

fs.cpSync(path.join(root, 'packages/viewer/dist'), path.join(out, 'viewer'), { recursive: true });
fs.copyFileSync(path.join(root, 'README.md'), path.join(out, 'README.md'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));

const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
// The Agent SDK is only for the standalone CLI (`illume "<question>"`), and it brings a whole Claude Code binary (about
// 250 MB). The plugin and channel use the person's own Claude Code instead, and with it as a dependency their first
// `npx` start downloaded so much that Claude Code gave up waiting ("Connection closed"). So it's an optional peer:
// npm doesn't install it, and the CLI says how to when it's asked to call Claude (`loadSdk` in agent.ts).
const OPTIONAL = ['@anthropic-ai/claude-agent-sdk'];
const sorted = (entries) => Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
pkg.dependencies = sorted(Object.entries(deps).filter(([name]) => !OPTIONAL.includes(name)));
pkg.peerDependencies = sorted(Object.entries(deps).filter(([name]) => OPTIONAL.includes(name)));
pkg.peerDependenciesMeta = Object.fromEntries(OPTIONAL.map((name) => [name, { optional: true }]));
fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`release/ is ready: ${pkg.name}@${pkg.version}`);
