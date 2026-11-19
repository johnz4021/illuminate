// Preview the whole app without calling Claude: the real server and viewer, on a throwaway copy of the care-app
// fixture, with a scripted stand-in for Claude (it streams progress, returns the fixture map, answers, proposes a fix).
// For UI work and demos:  npm run preview   (then open the printed link)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, AgentRequest } from '../src/agent';
import { MAP_SCHEMA, QUICK_ANSWER_SCHEMA } from '../src/schemas';
import { startServer } from '../src/server';

const fixture = (p: string) => fileURLToPath(new URL(`../../core/test/fixtures/${p}`, import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'illuminate-preview-'));
cpSync(fixture('care-app'), root, { recursive: true });
const MAP = JSON.parse(readFileSync(fixture('care-app.map.json'), 'utf8'));
const JOURNEY = JSON.parse(readFileSync(fixture('care-app.journey.json'), 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The copy is a git repo with one commit, so a question about a change has something to compare with.
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=preview', '-c', 'user.email=preview@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
try {
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'the care app');
} catch {
  // No git here: the change map below will say it can't find its commit.
}

/**
 * Asked what changed, the stand-in first makes a change to the copy (a listener is added, the service is edited, the
 * nightly job is deleted) and returns the map of it. The other scripted answers describe the app before that change.
 */
function changeMap() {
  if (!existsSync(join(root, 'src/automations/listeners.ts'))) {
    writeFileSync(join(root, 'src/automations/listeners.ts'), "import { bus } from '../events/bus';\nimport { evaluateRules } from './evaluate';\n\nexport function listenForConversions() {\n  bus.on('patient.converted', ({ patientId }) => evaluateRules({ patientId }));\n}\n");
    const service = join(root, 'src/patients/service.ts');
    writeFileSync(service, readFileSync(service, 'utf8').replace("  bus.emit('patient.converted', { patientId });", "  console.log('converted', patientId);\n  bus.emit('patient.converted', { patientId });"));
    rmSync(join(root, 'src/jobs/nightly.ts'), { force: true });
  }
  const m = structuredClone(MAP);
  m.since = 'HEAD';
  m.absences = [];
  m.nodes.push({ id: 'l1', area: 'automations', name: 'Hears the announcement', symbol: 'src/automations/listeners.ts#listenForConversions', explain: { concept: 'New: it listens for a patient converting and runs the rules right away.' }, evidence: [{ file: 'src/automations/listeners.ts', line: 5, text: "bus.on('patient.converted'" }] });
  m.edges.push({ id: 'eh', from: 's4', to: 'l1', kind: 'then', label: 'is heard by', evidence: [{ file: 'src/automations/listeners.ts', line: 5, text: "bus.on('patient.converted'" }] });
  m.edges.push({ id: 'el', from: 'l1', to: 'u1', kind: 'calls', label: 'runs the rules', evidence: [{ file: 'src/automations/listeners.ts', line: 5, text: 'evaluateRules({ patientId })' }] });
  m.edges.find((e: { id: string }) => e.id === 'e34').evidence[0].line = 7;
  for (const x of [m.nodes.find((n: { id: string }) => n.id === 'j1'), m.edges.find((e: { id: string }) => e.id === 'ej')]) x.removed = true;
  m.tour = [
    { id: 'c1', title: 'The welcome email now goes out right away', text: 'A listener was added that runs the rules the moment a patient converts, and the nightly job that did it a day late was deleted.', focus: { nodes: ['l1', 'j1'] } },
    { id: 'c2', title: 'What was added', text: 'The new listener hears the announcement and runs the automation rules straight away.', focus: { nodes: ['s4', 'l1', 'u1'], edges: ['eh', 'el'] } },
    { id: 'c3', title: 'What was removed', text: 'The nightly job, and its call to the rules, are gone.', focus: { nodes: ['j1'], edges: ['ej'] } },
    { id: 'c4', title: 'What was edited', text: 'Marking a patient as enrolled now also writes a line to the log. The rest of the path is as it was.', focus: { nodes: ['s3', 's4'] } },
  ];
  return m;
}

async function narrate(req: AgentRequest, steps: [string, string][]) {
  for (const [kind, text] of steps) {
    await sleep(450);
    req.onProgress?.({ kind: kind as 'read' | 'search' | 'list', text });
  }
}

const agent: Agent = async (req) => {
  if (req.schema === MAP_SCHEMA) {
    await narrate(req, [
      ['read', 'Reading src/ui/PatientHeader.tsx'],
      ['read', 'Reading src/server/routes.ts'],
      ['read', 'Reading src/patients/service.ts'],
      ['search', 'Searching for "patient\\.converted"'],
      ['read', 'Reading src/automations/evaluate.ts'],
      ['read', 'Reading src/jobs/nightly.ts'],
    ]);
    // Asked what someone sees or goes through, the stand-in returns the journey: the same app as a user flow.
    const asked = req.prompt.slice(req.prompt.indexOf('## The question')).split('\n')[1] ?? '';
    // Asked what changed, it makes a change to the copy and returns the map of it.
    if (/\bchanged?\b|\bdiff\b/i.test(asked)) return { output: changeMap(), sessionId: 'preview-maker', cost: 0 };
    const journey = /journey|go(es)? through|user flow|\bsees?\b/i.test(asked);
    return { output: journey ? JOURNEY : MAP, sessionId: 'preview-maker', cost: 0 };
  }
  // Only the question itself (the line after "## Their question"), not the instructions around it.
  const q = req.prompt.slice(req.prompt.indexOf('## Their question')).split('\n')[1] ?? '';
  // The map-only first try: questions about where things run or changes need the code; anything else is on the map.
  if (req.schema === QUICK_ANSWER_SCHEMA) {
    await sleep(600);
    // Billing isn't part of this map (or this app): the "different part of the app" card.
    if (/invoice|bill/i.test(q)) return { output: { route: 'elsewhere', newQuestion: 'How does the app bill patients and send invoices?' }, sessionId: null, cost: 0 };
    if (/how would|what would|plan|propos/i.test(q)) return { output: { route: 'code', missing: 'What the change would touch.' }, sessionId: null, cost: 0 };
    if (/make|change|fix|right away|immediately|where|when|run/i.test(q)) return { output: { route: 'code', missing: 'Code the map doesn\'t show.' }, sessionId: null, cost: 0 };
  }
  // A plan, not a request to make the change: drawn on the map as a proposal, on top of the code as it is.
  if (/how would|what would|plan|propos/i.test(q)) {
    await narrate(req, [['read', 'Reading src/events/bus.ts'], ['read', 'Reading src/jobs/nightly.ts']]);
    return {
      output: {
        concept: 'Add a listener that runs the rules the moment a patient converts, and drop the nightly job that does it late. Staff would also see that the email was sent. The violet parts are the proposal; nothing has been changed.',
        refs: ['p-listen', 'j1', 's1'],
        add: {
          nodes: [{ id: 'p-listen', area: 'automations', name: 'Hears the announcement', symbol: 'src/automations/listeners.ts#onConverted', explain: { concept: 'A new listener that reacts as soon as a patient converts.' }, proposed: { kind: 'add', note: 'So the welcome email no longer waits for the night.' } }],
          edges: [
            { id: 'p-heard', from: 's4', to: 'p-listen', kind: 'then', label: 'is heard by', proposed: { kind: 'add' } },
            { id: 'p-runs', from: 'p-listen', to: 'u1', kind: 'calls', label: 'runs the rules', proposed: { kind: 'add' } },
          ],
        },
        propose: [
          { id: 'j1', proposed: { kind: 'remove', note: 'Not needed once the listener runs the rules right away.' } },
          { id: 'ej', proposed: { kind: 'remove' } },
          { id: 's1', proposed: { kind: 'change', note: 'Show staff that the welcome email went out.' } },
        ],
        screens: [{ node: 's1', screen: { kind: 'sketch', file: 'src/ui/PatientHeader.tsx', elements: [{ kind: 'button', text: 'Mark as converted' }, { kind: 'text', text: 'Welcome email sent', proposed: true }] } }],
        moves: { focus: 'p-listen', highlight: ['s4', 'p-heard', 'p-listen', 'p-runs', 'u1', 'j1', 'ej'] },
      },
      sessionId: 'preview-explainer',
      cost: 0,
    };
  }
  if (/make|change|fix|right away|immediately/i.test(q)) {
    await narrate(req, [['read', 'Reading src/events/bus.ts'], ['search', 'Searching for "bus\\.on\\("']]);
    return {
      output: {
        concept: 'The email goes out right away if something listens for the "patient converted" announcement and runs the rules. Adding a small listener does that; the nightly job stays as a backup.',
        refs: ['s4', 'miss', 'u1'],
        moves: { focus: 's4', highlight: ['s4', 'u1', 'miss'] },
        fix: {
          summary: 'Run the automation rules as soon as a patient converts, by listening for the announcement. The nightly job stays as a backup.',
          edits: [],
          creates: [{ file: 'src/automations/listeners.ts', content: "import { bus } from '../events/bus';\nimport { evaluateRules } from './evaluate';\n\nbus.on('patient.converted', ({ patientId }) => evaluateRules({ patientId }));\n" }],
          connects: { from: 's4', to: 'u1', label: 'now listens', evidenceFile: 'src/automations/listeners.ts', evidenceText: "bus.on('patient.converted'" },
        },
      },
      sessionId: 'preview-explainer',
      cost: 0,
    };
  }
  if (/where|when|run/i.test(q)) {
    await narrate(req, [['search', 'Searching for "evaluateRules\\("'], ['read', 'Reading src/jobs/nightly.ts']]);
    return {
      output: {
        concept: 'The rules only run in a nightly job at 2:00 am, and only for patients created the day before. A patient who converts today waits until tonight at the earliest.',
        refs: ['j1', 'ej', 'u1', 'n-yesterday'],
        add: {
          nodes: [{ id: 'n-yesterday', area: 'jobs', name: "Yesterday's patients only", symbol: 'src/jobs/nightly.ts#runNightly', explain: { concept: 'The nightly job only looks at patients created the day before.' }, evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: 'createdAfter: yesterday' }] }],
          edges: [{ id: 'e-yesterday', from: 'j1', to: 'n-yesterday', kind: 'then', label: 'filters', evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: "db.where('patients'" }] }],
        },
        moves: { focus: 'j1', highlight: ['j1', 'n-yesterday', 'ej', 'u1', 'eu12', 'u2', 'eu23', 'u3'] },
      },
      sessionId: 'preview-explainer',
      cost: 0,
    };
  }
  await narrate(req, [['read', 'Reading src/patients/service.ts']]);
  return {
    output: {
      concept: 'This is where the app tells the rest of the system that a patient just enrolled, so other parts can react, for example by sending the welcome email. Right now nothing is listening, so that reaction never happens.',
      route: 'answer',
      refs: ['s4', 'miss'],
      moves: { focus: 's4', highlight: ['s4', 'miss', 'u1'] },
      // Lines the answer points at: shown as code under the reply, each note beside its line.
      notes: [
        { file: 'src/patients/service.ts', line: 5, text: "db.update('patients'", note: 'First the patient is saved as enrolled.' },
        { file: 'src/patients/service.ts', line: 6, text: "bus.emit('patient.converted'", note: 'Then the announcement goes out. All it carries is the patient id.' },
      ],
    },
    sessionId: 'preview-explainer',
    cost: 0,
  };
};

const cleanUp = () => rmSync(root, { recursive: true, force: true });
// No autoStop here (a preview stays up for UI work), but the page's Stop button still ends it.
// PREVIEW_AGENT=codex shows the page as it is in Codex: questions are asked in the Codex chat, not on the page.
const page = process.env.PREVIEW_AGENT === 'codex' ? { name: 'Codex', asks: 'chat' as const } : undefined;
const server = await startServer({ root, port: Number(process.env.PORT ?? 4318), agent, page, onStop: () => { cleanUp(); process.exit(0); } });
const id = server.startMap(process.env.PREVIEW_QUESTION ?? 'What happens when a patient converts? Does the welcome email go out?');
console.log(`\nilluminate preview (scripted Claude, no model calls) on a copy of the care app:\n\n  ${server.pageUrl(id)}\n`);
const stop = () => void server.close().then(() => { cleanUp(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
