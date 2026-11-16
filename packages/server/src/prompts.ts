// Every prompt illuminate sends. The reader is semi-technical: they can follow a diagram but don't hold the system in
// their head. Plain English first; code names belong in the "code" depth.
import { settledProposals, type CheckReport, type CodeMap } from '@illuminate/core';

const EVIDENCE_RULES = [
  '## Evidence rules (a program checks every claim; anything it can\'t confirm is shown as unconfirmed)',
  '- Every box and arrow that is in the code cites at least one line: `file` (repo-relative), `line` (1-based), and `text` copied exactly from that line. A distinctive fragment of 10–80 characters works best.',
  '- A box that is a function or method gets `symbol`: "<file>#<name>", named the way the checker names it: methods as Class.method, object members as obj.member ("src/db.ts#db.update"), a function inside another function as outer.inner, and a function in the object a factory returns as factory.member. When a list of functions by file is given, copy the name from it. If you aren\'t sure of the name, leave `symbol` out: the box is still checked by its cited line.',
  '- Arrow `kind`: `calls` when a function in the from box literally calls the function in the to box; `request` when an HTTP call in the from box hits a route handled by the to box; `imports`; `then` for anything else (events, ordering). The checker verifies calls, request and imports against the code, so use them only when literally true.',
  '- Never cite or read secret files (.env, keys).',
];

const MAP_RULES = [
  '## What a good map is',
  '- It follows what happens, in order, from where it starts (a button, a route, a job, a command) to where it ends (a table write, an email, an outside API), or to where it stops.',
  '- 2–6 `areas` named in product language (Patients, Billing, Background jobs), not folder names.',
  '- Aim for 6–8 boxes (`nodes`); 12 is a hard ceiling, reached only when the question asks about several things at once. A map is an answer, not an inventory: someone should be able to hold it in their head. Each box is one step a person would recognize and that the answer turns on.',
  '- Leave plumbing off the map unless the question is about it: a request arriving, a job being started, a result being saved, an update being sent to the screen. Fold each into the box it serves and say it in that box\'s `explain` or on the arrow.',
  '- When several steps in a row just hand on to the next (a route that calls a handler that calls a service), they are one box, cited at the step that matters.',
  '- When the answer is a list of like things (five kinds of rule, four checks), that is one box naming the group, or at most the two or three that differ in a way the question cares about; put the rest in `explain`.',
  '- Before returning, go through the boxes one at a time: if the answer would be the same without it, drop or merge it.',
  '- Box `name`: plain English, at most 30 characters ("Patient marked enrolled", not "markConverted()").',
  '- `kind`: entry (a way in), step, store (table, queue, cache), external (outside service), job (scheduled or background work).',
  '- `explain` for every box: just `concept`, 1–2 plain sentences, no jargon, saying what this step does. The box already shows its function and file, so leave those out.',
  '- Arrow `label`: 1–3 words saying how one step leads to the next ("sends request", "calls", "announces", "every night").',
  '- Code that exists but isn\'t reached from the start can still be boxes. Don\'t draw arrows that don\'t exist.',
  '- An `absence` is a break in the flow you were asked about: a step on that path should lead to the next one and doesn\'t (something is announced that nothing listens for, a job that nothing ever starts). Most maps have none, and a map without one is complete. Don\'t go looking for one, and don\'t use one for a design choice or guarantee ("X never calls Y", "nothing here edits files"): say that in a box\'s explanation or the walkthrough instead. Don\'t record small mismatches beside the question (a command the docs don\'t mention, an unused option).',
  '- When there is a break, record it: the `claim` in plain words, the two boxes it should connect (`between`), and the exact `search` that proves nothing is there (`pattern`, `regex`, optional `paths` globs covering every file where the missing piece could live), with `matches` set to the count that search returns (usually 0). Run that search yourself with Grep first.',
];

/** A journey: the map told as what a person sees and does, each step still tied to the code that makes it so. */
const JOURNEY_RULES = [
  '## When the question is about what a person sees or does (a journey, a user flow)',
  '- Set `"view": "journey"` on the map: it is then drawn as a user flow, left to right, with no code on the boxes (the code is one click away).',
  '- `kind` here is one of: `screen` (something the person looks at), `action` (something they do that is a step in itself: "Fills in the form", "Pays"), `choice` (a point where they pick between ways forward, named as the question they face: "Buy now or add to bag?"; each arrow out of it is one option, labeled with what they pick). Use a `choice` wherever the path forks on what the person decides, rather than two arrows out of a screen.',
  '- Draw only what the person sees and does. Every box is a screen they look at or something they do on one, in order, named the way they would say it ("Sign-up form", "Email confirmed"). Areas are the stages of the journey as the person lives them ("Choosing", "Paying", "Waiting for it"). Arrows say what the person does or what happens to them next ("taps Sign up", "is sent to").',
  '- Leave out what goes on behind the screen: no boxes for routes, requests, functions, jobs, database writes or other services. When several of those sit between two screens, they are one arrow ("pays, and lands on"), and that arrow cites the code that does it. A step that happens outside the app is a box only if the person sees it (a payment page, an email they get), cited at the line that sends them there or sends it.',
  '- A wait is part of the journey: when the next thing the person sees comes later (an email after a nightly job, an order shipped after approval), say so on the arrow in their terms ("a day later, gets"), and don\'t draw the job.',
  '- Each box and arrow still cites the code that makes it so: the component, the handler, the redirect.',
  '- Show where each step happens: define the pages the journey goes through once, in `pages`, and give each screen box a wireframe of its page with its own part marked (see Screens). Several boxes usually share one page. A box whose page can\'t be drawn usefully (nothing recognisable on it, or it isn\'t in this repo) gets no `screen`: no picture is better than a thin one.',
  '- Where the journey stops short (a button that leads nowhere, a result with no screen, nothing ever telling the person what happened), that is a break: record it as an absence.',
  '- The walkthrough is told as the person\'s experience too, one stop per screen.',
];

/** Proposals: what the map suggests changing, drawn on top of the code as it is. */
export const PROPOSAL_RULES = [
  '## Proposals (`proposed` on a box or arrow; only when a change is asked for)',
  '- When they ask how something could or should change ("how would we add…", "plan…", "what would it take to…", "propose…"), draw the code as it is, cited and checked as usual, and the change on top of it. A question about how things work today gets no proposals.',
  '- `"proposed": { "kind": "add", "note": "…" }`: a box or arrow that isn\'t in the code yet. It cites nothing, so leave `evidence` out. Give a new box the `symbol` it would have ("<file>#<name>"; the file may be new) and a new arrow its real `kind` (`calls`, `request`, `imports`): that is how the check can tell, later, that it has been built. An arrow to or from a new box is itself an addition.',
  '- `"kind": "change"` or `"remove"`: code that is there today and would be changed or deleted. Cite it like any other claim.',
  '- `note`: one plain sentence saying what would change and why.',
  '- Every new box must connect, through arrows, to a box that exists. Keep it small: only the boxes and arrows the change needs.',
  '- On a screen: a box with `proposed` may have a sketch with elements marked `"proposed": true` for what would be added to it, and a new screen is a new box whose sketch is all new.',
  '- A program checks proposals against the code too. Proposing to add what the code already has, or to change or remove what it doesn\'t have, is sent back.',
];

/** A map of a change: the code as it is now, compared by the checker with a commit; only what has gone is marked. */
export const CHANGE_RULES = [
  '## When the question is about a change (what changed, what a commit or a task did, "what did you just change")',
  '- Set `"since"` on the map to the commit to compare with: "HEAD" for work that isn\'t committed yet, "HEAD~1" for the last commit, or the branch or commit they name. A question about how things work today gets no `since`.',
  '- Draw the flow the change belongs to as it works now, the map you would draw if they had asked how it works: start where it starts and follow it through, steps that didn\'t change included. The person reads the change against those: a map where every box is new or changed shows no before, and can\'t be told from a map of something else. As a guide, at least a third of the boxes are ones that didn\'t change (the steps the change plugs into, what calls the new code, what it hands on to). Leave out helpers the change added that aren\'t steps of the flow.',
  '- Cite everything as usual. Don\'t mark what is new or different: a program compares every box and arrow with that commit and marks them itself. It compares a box that names its function (`symbol`) as that function, so give new and changed boxes their `symbol`; for anything else, cite a line that is new.',
  '- Code that was deleted is a box or arrow with `"removed": true`. It cites the code as it was at that commit: `file`, `line` and `text` from the old version (`git show <since>:<file>` shows it, when you can run git). An arrow to or from a removed box is removed too. The program checks that it was there then and is gone now, so use it only for code that is really gone, not for code that moved or was renamed.',
  '- In the explanation of each box that changed, say what is different now, in plain words ("Now also tells the listener"), not as a diff.',
  '- If you made the change yourself in this conversation, draw what you changed and what it touches. Other differences from that commit that aren\'t part of it stay off the map.',
  '- The walkthrough says what changed first, then follows the changed path in the order things happen.',
];

/** When a picture of the screen helps, and the three forms the checker accepts. */
export const SCREEN_RULES = [
  '## Screens (`pages` on the map, `screen` on a box; optional, and your call)',
  '- A picture of where a step happens on the screen can ground a map for people who don\'t read code. Add one where the flow touches the screen and seeing it helps: usually the box where it starts (the button or form), sometimes where a result appears. For backend-only questions, add none.',
  '- The usual picture is a wireframe of the whole page, with the part the box is about marked. Define each page once, in the map\'s `pages`: `{ "id": "…", "name": "Patient page", "file": "<the page\'s own component or template>", "regions": [ … ] }`.',
  '- A region is one visible part of the page: `{ "id": "…", "slot": "top" | "left" | "main" | "right" | "bottom", "label": "Top bar", "file": "<the file it comes from>", "elements": [{ "kind": "heading|button|field|link|text|image", "text": "…" }] }`. Give the 3–6 regions a person would recognise the page by, not only the one the step uses. Put each in the slot where it appears on screen, going by the markup and the styles (a bar across the top is `top`, a sidebar is `left` or `right`, the content is `main`). `elements`: up to 6 of the most recognisable things in the region, in the order they appear, each `text` copied exactly from that region\'s file; a region may have none.',
  '- Then on a box: `"screen": { "kind": "wireframe", "page": "<page id>", "region": "<region id>", "highlight": "<text of one element in that region>" }`. Boxes that happen on the same page use the same page, each marking its own region and element.',
  '- A program checks every page: a region\'s `file` must be the page\'s `file` or one it imports (directly or through other files), every element\'s text must be in its region\'s file, and the box must cite the page\'s code or the code the marked element is in. A region that fails is left off; where regions sit can\'t be checked, so read the layout from the code and don\'t invent parts.',
  '- `{ "kind": "capture", "capture": "<id>", "highlight": "<label>" }`: a real screenshot, in place of a wireframe, when a page is already running on this machine. Only if you have the illuminate_capture tool: it screenshots a running page or an HTML file in the repo, and returns the id. Look at the image first, and don\'t use one that shows a login page, an error or the wrong state. Never start the app yourself.',
  '- `{ "kind": "image", "file": "<path>" }`: an image file in the repo (an icon, a sprite) that the box\'s cited code names.',
  '- `{ "kind": "sketch", "file": "<markup file>", "elements": [ … ], "highlight": "<one element\'s text>" }`: the visible things in one component, as a list. Only for a proposal (see Proposals): it can show elements that aren\'t there yet.',
];

const TOUR_RULES = [
  '## Walkthrough (`tour`, written last)',
  '- 4–7 stops in the order a newcomer should read them: the answer, then the path, then what it means. If the map has a break, give it a stop where it happens on the path.',
  '- The first stop answers their question outright, in a sentence or two, as you would if they asked you in person ("The welcome email never goes out: the app announces the conversion, but nothing is listening."). Its `title` is the answer in a few words. Don\'t open by describing the map ("This map follows…", "It has three areas…"): they can see it. Focus it on the boxes the answer turns on.',
  '- Each stop: `title`, `text` (2–3 plain sentences), `focus` (ids of the areas, nodes, edges or absences it\'s about), and optional `terms` it uses that need defining.',
  '- Point stops only at boxes, arrows and absences you\'re confident in.',
  '- If the map has proposals, give them a stop after the path: what would change, and what stays as it is.',
];

export function makerPrompt(question: string, headStart: string): string {
  return [
    'You make a map that answers a question about this codebase, for someone semi-technical. Explore with Read, Grep and Glob, then return the map as JSON. You cannot edit anything.',
    '',
    `## The question\n"${question}"`,
    '',
    ...MAP_RULES,
    '',
    ...JOURNEY_RULES,
    '',
    ...EVIDENCE_RULES,
    '',
    ...PROPOSAL_RULES,
    '',
    ...CHANGE_RULES,
    '',
    ...SCREEN_RULES,
    '',
    ...TOUR_RULES,
    '',
    '## Head start (from a quick automatic scan; it may be incomplete)',
    headStart,
    '',
    'Return the map: `version` 1, the `question`, `areas`, `nodes`, `edges`, `absences`, `tour` (and `view` or `since` when the rules above call for them).',
  ].join('\n');
}

export function shapeRepairPrompt(problems: readonly string[]): string {
  return [
    'The map you returned has problems that stop it from being drawn:',
    ...problems.map((p) => `- ${p}`),
    '',
    'Return the complete corrected map.',
  ].join('\n');
}

/** What a repair prompt needs to suggest real names: the function names the code facts know in a file. */
export type SymbolsIn = (file: string) => readonly string[];

const NO_SYMBOL = /^the code has no symbol (.+)#(.+)$/;
/** "the code has no symbol a.ts#save" → the same reason, plus the names in a.ts that end in `save` (or a few names). */
function withSuggestion(reason: string, symbolsIn: SymbolsIn | undefined): string {
  const m = NO_SYMBOL.exec(reason);
  if (!m || !symbolsIn) return reason;
  const [, file, name] = m as unknown as [string, string, string];
  const last = name.split('.').at(-1)!;
  const names = symbolsIn(file);
  const close = names.filter((n) => n === last || n.endsWith(`.${last}`));
  if (close.length) return `${reason} (in that file it's ${close.slice(0, 3).map((n) => `${file}#${n}`).join(' or ')})`;
  return names.length ? `${reason} (that file has: ${names.slice(0, 12).join(', ')})` : reason;
}

export function evidenceRepairPrompt(report: CheckReport, symbolsIn?: SymbolsIn): string {
  const why = (reasons: string[]) => reasons.map((r) => withSuggestion(r, symbolsIn)).join('; ');
  const lines = [
    ...Object.entries(report.nodes).filter(([, c]) => c.status === 'unconfirmed').map(([id, c]) => `- box ${id}: ${why(c.reasons)}`),
    ...Object.entries(report.edges).filter(([, c]) => c.status === 'unconfirmed').map(([id, c]) => `- arrow ${id}: ${why(c.reasons)}`),
    ...settledProposals(report).map((p) =>
      p.kind === 'add'
        ? `- ${p.what} ${p.id}: you propose adding it, but the code already has it. Draw it as code that exists (cite its line, no \`proposed\`), or drop it.`
        : `- ${p.what} ${p.id}: you propose to ${p.kind} it, so it must cite code that is there now: ${why(p.reasons)}`),
    ...Object.entries(report.absences).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `- absence ${id}: ${c.reasons.join('; ')}${c.locations.length ? ` (found at ${c.locations.slice(0, 5).map((l) => `${l.file}:${l.line}`).join(', ')})` : ''}`),
  ];
  const screens = Object.entries(report.screens ?? {}).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `- screen on box ${id}: ${c.reasons.join('; ')}`);
  return [
    'The checker re-read the code and could not confirm these claims:',
    ...lines,
    ...(screens.length ? ['', 'These screens can\'t be shown either (fix the `screen` on the box, or return the box without it):', ...screens] : []),
    '',
    'Fix only these. For each one, correct it (exact line text, right line number, a real symbol name, the right arrow kind) or drop it if it isn\'t true. If an absence was wrong, the code is connected after all: drop the absence and add that arrow.',
    '',
    'Return only the changes, not the whole map. Put each corrected box, arrow or absence (complete, with all its fields and the same id) and anything new in `nodes`, `edges`, `absences` or `areas`, and the ids of claims to drop in `remove`. Everything you leave out stays as it is.',
  ].join('\n');
}

export function patchRepairPrompt(problems: readonly string[]): string {
  return [
    'Your changes couldn\'t be applied to the map:',
    ...problems.map((p) => `- ${p}`),
    '',
    'Return the corrected changes, in the same form: only what changes, each item complete.',
  ].join('\n');
}

export type SelectionLine = { id: string; label: string };

/** The map, what the checker couldn't confirm, what they selected and their question: shared by both answer prompts. */
function questionContext(map: CodeMap, report: CheckReport, selection: readonly SelectionLine[], question: string): string[] {
  const all = [...Object.entries(report.nodes), ...Object.entries(report.edges), ...Object.entries(report.absences)];
  const unconfirmed = all.filter(([, c]) => c.status === 'unconfirmed').map(([id]) => id);
  const proposals = [...Object.entries(report.nodes), ...Object.entries(report.edges)].flatMap(([id, c]) => (c.proposal ? [`${id} (${c.proposal.kind}: ${c.proposal.state === 'done' ? 'now done in the code' : 'not done yet'})`] : []));
  return [
    '## The map (JSON)',
    JSON.stringify(map),
    unconfirmed.length ? `\nThe checker could not confirm: ${unconfirmed.join(', ')}. Don\'t rely on those without checking.` : '\nThe checker confirmed every claim in the map about the code as it is.',
    ...(proposals.length ? [`These are proposals, not code as it is; the checker says where each stands: ${proposals.join(', ')}.`] : []),
    ...changesContext(report),
    '',
    selection.length ? `## They selected\n${selection.map((s) => `- ${s.id}: ${s.label}`).join('\n')}` : '## They selected nothing (the question is about the whole map)',
    '',
    `## Their question\n"${question}"`,
  ];
}

/** On a map of a change: what the checker found new, different or gone, with the lines of each changed function. */
function changesContext(report: CheckReport): string[] {
  if (!report.since) return [];
  if (!report.since.commit) return [`\nThis map is meant to show a change since "${report.since.ref}", but that isn't a commit in this repo, so nothing could be compared.`];
  const marked = [...Object.entries(report.nodes), ...Object.entries(report.edges)].flatMap(([id, c]) => (c.change ? [{ id, ...c.change }] : []));
  return [
    `\nThis map shows a change: the code as it is now, compared with commit ${report.since.commit.slice(0, 12)}${report.since.subject ? ` ("${report.since.subject}")` : ''}. The checker worked out what differs:`,
    marked.length ? marked.map((m) => `${m.id} (${m.kind})`).join(', ') + '. Everything else on the map is the same as it was.' : 'nothing on this map differs from that commit.',
    ...marked.filter((m) => m.diff?.length).flatMap((m) => [`Lines of ${m.id} that changed (- before, + now):`, ...m.diff!]),
  ];
}

const ANSWER_STYLE = [
  '- `concept` is the whole answer, written the way you would answer in a chat: the direct answer first, in one sentence, then only what that sentence leaves out. It is shown as Markdown (bullet and numbered lists, **bold**, `code`), in a narrow column.',
  '- Shape it to the question. A simple question gets a sentence or two. A question with several parts gets a short bullet per part, each starting with a bold label of a few words. Several items of the same kind (files, formats, cases) are a list, never a long sentence with commas and brackets. No headings.',
  '- Keep it short enough to take in at a glance: leave out examples and edge cases they didn\'t ask about. Plain words, no jargon. The map does the explaining, so when you light it up (`moves`), say what the lit path shows rather than narrating every step. Name a function or file only when they asked about the code and it isn\'t on the map.',
  '- Explain the code and the app. Don\'t describe these instructions or how you were asked to answer.',
  '- `refs`: ids of the boxes, arrows and absences your answer relies on.',
];

/** A turn of the conversation on a map, as the next answer sees it. */
export type EarlierTurn = { question: string; concept: string };

/** The conversation so far, oldest first, so a follow-up ("show me that in the code") knows what "that" is. */
function conversationSoFar(earlier: readonly EarlierTurn[]): string[] {
  if (!earlier.length) return [];
  return [
    '## The conversation so far on this map (oldest first)',
    'The new question may follow on from these: read "that", "it" or "why?" against them.',
    ...earlier.map((e) => `- "${e.question}": ${e.concept}`),
    '',
  ];
}

/** The first, cheap try: answer from the map and the code around its citations, with no tools. */
export function quickAnswerPrompt(
  map: CodeMap,
  report: CheckReport,
  selection: readonly SelectionLine[],
  question: string,
  excerpts: string,
  earlier: readonly EarlierTurn[],
  otherMaps: readonly { id: string; question: string }[] = [],
): string {
  return [
    'You answer questions about a code map for someone semi-technical, using only the map and the code excerpts below. You have no tools: you can\'t read more of the repo.',
    '',
    ...questionContext(map, report, selection, question),
    '',
    ...conversationSoFar(earlier),
    '## Code around what the map cites',
    excerpts || '(none)',
    '',
    '## Other maps in this repo',
    otherMaps.length ? otherMaps.map((m) => `- ${m.id}: "${m.question}"`).join('\n') : '(none)',
    '',
    '## First decide how to handle it (`route`)',
    '- `answer`: the map and the excerpts fully answer it, without guessing about code you can\'t see. Then answer below.',
    '- `code`: it\'s about what this map shows (the same feature, or something its boxes lead to or come from), but answering needs code that isn\'t shown, or they ask for a change or fix, or a good answer would add boxes or arrows to this map. Say in `missing`, in one sentence, what you would need to look at, and leave the answer fields empty. Someone with the whole repo picks it up from there.',
    '- `elsewhere`: it\'s about a different part of the app that this map doesn\'t touch, so adding it here would bolt an unrelated area onto this map. Put in `newQuestion` the question as a new map would ask it (their words, standing on its own), and if one of the other maps above already covers it, that map\'s id in `existingMap`. Leave the answer fields empty. They\'ll be asked whether to make a new map. Only use this when the question really is about something else; when in doubt, use `code`.',
    '',
    '## How to answer (when `route` is `answer`)',
    ...ANSWER_STYLE,
    '- `moves`: `focus` on the most relevant id; `highlight` the ids that make up the path that answers the question.',
  ].join('\n');
}

export function explainerPrompt(
  map: CodeMap,
  report: CheckReport,
  selection: readonly SelectionLine[],
  question: string,
  missing = '',
  wordsOnly = false,
  earlier: readonly EarlierTurn[] = [],
): string {
  if (wordsOnly) {
    return [
      'You answer questions about a codebase for someone semi-technical. You can Read, Grep and Glob the repo; you cannot edit anything.',
      '',
      ...questionContext(map, report, selection, question),
      '',
      ...conversationSoFar(earlier),
      '## This question is about a different part of the app than the map shows',
      'They chose an answer in words rather than a new map. Explore the code to answer it, but leave out `add` and `fix`: nothing will be drawn on this map. Use `refs` and `moves` only for ids on this map that really matter to the answer (often none).',
      '',
      '## How to answer',
      ...ANSWER_STYLE,
    ].join('\n');
  }
  return [
    'You answer questions about a code map for someone semi-technical. You can Read, Grep and Glob the repo; you cannot edit anything.',
    '',
    ...questionContext(map, report, selection, question),
    ...(map.view === 'journey' ? ['', '## This map is a journey', 'It shows only what a person sees and does. Anything you add must be the same: `kind` is `screen`, `action` or `choice`, and no boxes for what goes on behind the screen. Say that part in words.'] : []),
    ...(map.since ? ['', '## This map shows a change', `It compares the code as it is now with commit ${map.since.slice(0, 12)}, and a program marks what is new or different since then. Anything you add is compared the same way, so don't mark it yourself. Only code that was deleted since that commit gets \`"removed": true\`, citing its lines as they were then (an arrow to or from a removed box is removed too).`] : []),
    ...(missing ? ['', `## Why the map alone wasn't enough\n${missing}`] : []),
    '',
    ...conversationSoFar(earlier),
    '## How to answer',
    ...ANSWER_STYLE,
    '- If the map doesn\'t cover it, explore. Put what you found in `add` (new areas, nodes, edges or absences with evidence, same rules as the map; ids must be new) only when it belongs to the flow this map follows and seeing it drawn helps answer the question. If the answer is a fact you can say in words, or about something beside the flow, leave `add` empty. Connect new boxes to existing ones with arrows where the code really connects them.',
    '- `moves`: `focus` on the most relevant id; `highlight` the ids that make up the path that answers the question.',
    '- If they ask what a change would look like, how you would do something, or for a plan, without asking you to make it: draw it on the map as proposals (see Proposals). New boxes and arrows go in `add` with `proposed`; for a box or arrow already on the map that would change or go, put `{ "id": "<its id>", "proposed": { "kind": "change" | "remove", "note": "…" } }` in `propose`. Say in the answer what the proposal is; nothing is edited.',
    '- If they ask you to make a change, don\'t edit (you can\'t). Propose a `fix`: illuminate shows it to them on the map, and if they approve, illuminate applies exactly your edits and re-checks the map. So describe it as a proposal waiting for their approval, never as something for them to apply by hand.',
    '- The `fix`: `summary` in plain words; `edits` as exact replacements (`find` copied exactly from the file, occurring once; `replace` is the new text); `creates` for new files. If the fix creates a connection between two boxes, fill `connects` with `from`, `to`, a short `label`, and `evidenceFile` + `evidenceText` (text that will appear in the new code). Keep fixes small and in the style of the surrounding code.',
    '- When the question is about what the person sees at a step ("what does this look like?", "where is that button?"), answer with a picture: put `{ "node": "<box id>", "screen": { … } }` in `screens`, for a box already on the map or one in `add` (see Screens below). In an answer a wireframe can only use a page already in the map\'s `pages`; when the map has no page for it, a sketch of the component will do. Otherwise leave `screens` out: most questions don\'t need one.',
    '',
    ...EVIDENCE_RULES,
    '',
    ...PROPOSAL_RULES,
    '',
    ...SCREEN_RULES,
  ].join('\n');
}
