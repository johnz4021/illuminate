# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## illuminate

A map you can point at and ask about, for code you didn't write yourself. Read `README.md`, then `HANDOFF.md` (who it's
for, what users asked for, the decisions and why, what's next, gotchas). The design lives in the "Codemap v1 Design"
artifact (link in both).

## Rules

- **The model writes, the code decides.** Nothing reaches the screen without passing `check()` in `@illuminate/core`. A
  model never sets a claim's status; the checker computes it from the repo every time.
- **One checker, every call site.** Publishing a map, every answer, reopening a saved map, and after a fix all call the
  same `check()`. Don't fork its logic.
- **"Nothing does X" is a claim too.** Absences carry the search that proves them, and the checker reruns it.
- **A proposal is not a claim, and the map says which is which.** A box or arrow may carry `proposed` (add, change,
  remove). The checker computes where each stands from the repo (`pending` or `done`), the same way it computes every
  status; a proposed addition is the only thing on a map that cites no code, and it must connect to a box that exists.
- **What changed is computed, not claimed.** On a map of a change (`since`), the checker compares the code with that
  commit and marks what is new or different itself. The map only says which boxes and arrows were `removed`, since
  those cite code that is no longer there, and the checker confirms each against the old version.
- **Say what the check proves, and no more.** It proves every part is real code, not that the map is the whole story:
  the top bar says "Every part is in the code", and a gap shows the search behind it and how many files it covered.
- **The map format is the one-way door.** Change `packages/core/src/format.ts` deliberately, with tests. Everything
  else (generator, viewer, explainer) is replaceable behind it.
- **Read-only unless approved.** Illuminate writes to a target repo only under `.illuminate/`, and edits product code only
  after the user approves a fix previewed on the map. Claude never edits: it proposes, and `applyFix` writes exactly
  the approved change, refusing if the files changed since. Only one agent edits at a time.
- **All model calls go through one `Agent`** (`packages/server/src/agent.ts`): read-only tools, the secret guard,
  structured output. Tests inject a scripted `Agent`; `npm test` never calls a model.
- **Never read secrets.** `.env*`, keys and similar files are refused by `createRepoReader` and left out of searches.
  Paths in maps must stay inside the repo.
- **No model calls in `@illuminate/facts` or the checker.** They must be deterministic and fast.
- **Plain English in anything a person reads.** Jargon belongs in the code tab and in engineering detail.
- TypeScript strict, with `noUncheckedIndexedAccess`. Vitest. Pin dependency versions exactly.
- **Don't guess Agent SDK or Claude Code APIs** (channels, MCP Apps, hooks). Check the docs first.

## Commands

```
npm i
npm test             # every package, no model calls
npm run typecheck
npm run build        # viewer bundle (the server serves packages/viewer/dist)
npm run preview      # whole app with a scripted Claude, on a copy of the care-app fixture
npm run illume -- "<question>" --repo <dir>   # the real thing (uses Claude)
npm run illume -- check <map-id> --repo <dir> # re-check a saved map (exit 1 if a claim fails)

npm test -w @illuminate/core -- test/check.test.ts      # one file
npm test -w @illuminate/server -- -t "<test name>"      # one test by name
npm run dev -w @illuminate/viewer   # Vite on :5317, proxies /api and /ws to a server on ILLUMINATE_SERVER_PORT (4317)
```

- No build step for the TS packages: every `package.json` points `main` at `src/index.ts`, and `bin/illuminate.mjs`
  runs the CLI through tsx. Only the viewer is built, so rebuild it after viewer changes before `npm run illume`
  (`preview` rebuilds for you).
- Vitest only picks up `test/*.test.ts` (not nested). Fixture directories are excluded from each `tsconfig`.

## Context

- Packages: `facts` (deterministic code facts) → `core` (format, checker, map edits, safe repo reads) → `server`
  (maker, explainer, fixes, HTTP/WebSocket server, CLI) → `viewer` (React Flow + ELK). The viewer imports server and
  core types only (`import type`), never their runtime code.
- The agent skill is `plugin/skills/illuminate/SKILL.md`. The Claude Code plugin is `plugin/` (its MCP server runs
  `npx -y @johnz4021/illuminate@<version> channel`), listed by `.claude-plugin/marketplace.json` at the repo root.
  Codex reads the same marketplace and installs `plugin/` from `plugin/.codex-plugin/plugin.json` (`codex plugin
  marketplace add johnz4021/illuminate`, then `codex plugin add illuminate@illuminate`).
- Publishing: `npm run release` builds `release/` (server, core and facts bundled by esbuild into one file, plus the
  built viewer; third-party packages stay pinned dependencies). Bump the version in `release/package.json`,
  `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json` and the `npx` args (in both manifests'
  servers: `plugin.json` inline for Claude Code, `plugin/.codex-mcp.json` for Codex, which rejects an inline object)
  together, then `cd release && npm publish --access public`.
- `@illuminate/facts` was carried over from the hackathon harness (`../Speedhacks-project/packages/core`) with its tests.
  The harness is a separate project; don't import from it or edit it from here.
- Test fixtures: `packages/facts/test/{alias-repo,fixture-py,fixture-go}` and `packages/core/test/fixtures/care-app`
  (planted missing listener). Its `.env` holds a fake key for the secret-refusal tests.

## How the pieces fit

- **Scan** (`facts/src/scan.ts`): in a git repo `listRepoFiles` is what git tracks or would track, so nothing a
  `.gitignore` names (virtual environments, build output) is read; elsewhere it walks the folder. The head start leaves
  tests and fixtures out, and in a repo with more than 150 files of functions it drops the function list: illuminate
  doesn't try to out-search Claude, it only tries not to get in the way.
- **Make** (`server/src/maker.ts`): `headStart` (a `@illuminate/facts` scan, `hints.ts`) seeds the prompt, including every
  function name by file exactly as the checker knows it (`symbolIndex`) → `Agent` returns JSON against `MAP_SCHEMA` →
  `parseMap` → `check`. Unconfirmed claims get up to two repair rounds on the same session that return only changes
  (`MAP_PATCH_SCHEMA`, applied with `patchMap` in `core/src/edit.ts`), since writing the map is most of a map's time;
  a draft that can't be read at all is re-sent whole. The best-checked map wins. Prompts live in `prompts.ts`, output
  schemas in `schemas.ts`.
- **Symbol names** (`facts/src/facts/extract.ts`): functions inside functions are `outer.inner`, methods of an object a
  factory returns are `factory.member`; calls made in them belong to them (the checker's `within` treats `outer.inner`
  as part of `outer`, so maps citing the outer function still check).
- **Ask** (`explainer.ts`): first Claude sees the map, the code around its citations (`citedExcerpts`, plain code) and
  the repo's other maps, with no tools, and picks a `route`: `answer` (done, map unchanged), `code` (Claude explores the
  repo, resuming the explainer session; only this can add to the map, via `addToMap` in `core/src/edit.ts`, or propose
  a fix), or `elsewhere` (a different part of the app: the answer is an `offer`, and the person chooses a new map,
  linked back through `meta.parent`, or an answer in words, `wordsOnly`, that draws nothing). A selection on the map
  always means `code`, never `elsewhere`. Additions that don't pass `check` are dropped, not shown as unconfirmed.
- **Viewer layout**: the top bar only says which map this is (switcher, New map, Stop) and, in words, whether it still
  matches the code ("✓ Every part is in the code", or "6 parts of this map don't match the code"), with proposals
  counted apart ("2 of 3 proposed changes done"). The dock along
  the bottom (`dock.tsx`) starts the walkthrough, and holds the question box while the conversation is closed; zoom is
  the wheel or trackpad. The walkthrough runs in a bubble on the map (`tour.tsx`), its text and buttons together; the
  panel steps aside meanwhile (unless it has an error or Claude's progress) and the camera leaves room for the bubble.
  The Conversation button still shows then: it opens the panel beside the walkthrough (`peek` in `state.ts`) without
  ending it, and the stop is fitted into the narrower map; "Show on the map" on a reply is what ends the walkthrough.
  "Ask about this step" puts the stop in the question box as a chip (removable, like a selection); a question asked with it
  starts with the step's name for Claude (`step.ts`), and the conversation shows that under the question instead.
- **Conversation** (`panel.tsx`): the panel is the conversation on a map. Each turn is the question, then the reply
  (short Markdown shaped to the question, direct answer first: the map does the explaining, and boxes carry their code), then what came with it: a
  fix, the offer of a new map, or what it added (hideable). The reply lit on the map is drawn dark; "Show on the map"
  relights an earlier one. While it's open the question box sits at its bottom (one box, never two). It opens for an
  answer, Claude's progress or an error; closed, a button in the bottom-right corner reopens it (`history.tsx`).
  A selected box or arrow is described in a bubble beside it on the map (`bubble.tsx`, which places it in screen space
  on the side with room, keeps it above the dock, and moves the camera once if the box or bubble wouldn't fit; a grip
  on its far bottom corner resizes it, remembered in localStorage), never
  in the panel; during the walkthrough it takes the place of the walkthrough bubble until it's closed. Drag its
  left edge to resize it (`resize.tsx`, kept in localStorage); when the map area changes width, the camera keeps its
  middle in the middle. Claude gets the last six turns (`conversationSoFar` in `prompts.ts`) in both answer steps.
  Whatever Claude writes as prose (replies, box explanations, walkthrough stops, fix summaries) is shown as Markdown
  through `markdown.tsx`: a small subset, built as React elements, never HTML strings; links open only for http(s).
  Step boxes are `NODE_W`×`NODE_H` in `layout.ts`, which must match `.step` in `styles.css`.
- **Viewer navigation** (`viewer/src/nav.ts`): moving between maps and home is in-page (`history.pushState`), and
  in-app `<a href>` clicks are taken over, so the page never reloads.
- **Arrow label words** (the `label` rule in `MAP_RULES`): an arrow reads as a sentence, "<from box> <label> <to box>",
  so a label says who does the next step when it isn't the box the arrow leaves ("then Alice claims", not "claims with
  secret" after a box about Bob).
- **Arrow labels** (`viewer/src/labels.ts`): once a layout is drawn, each label is checked against the boxes and the
  labels placed before it, and slides along its own arrow to the first clear spot; with none it becomes a dot that
  shows its words when pointed at. A missing connection's label is placed first and never becomes a dot; area titles
  are avoided when possible. Arrows sit under boxes (`zIndexMode="manual"`: areas 0, arrows 1, boxes 3), so a line
  can pass under a box but never across its words.
- **Layers** (viewer): what each answer added (`answer.added`) can be hidden. The layout puts the original map down
  first and fits additions around it (rows below in existing areas, new areas to the right), so known boxes never move.
- **Channel** (`channel.ts`, `bridge.ts`; `illume channel`): illuminate as a Claude Code channel, an MCP server over
  stdio that runs the local server with a bridge `Agent`, so the user's own Claude Code session does the model work. A
  request goes to a tool call that is waiting (`illuminate_map` and `illuminate_submit` wait for what comes next, so a
  map is made in one turn). Between turns Claude keeps an `illuminate_listen` call open: Claude Code moves a call
  running past two minutes to the background and wakes the session when it returns, so questions asked on the map
  reach the session without the channel flag. Claude Code drops a call quiet for 30 minutes even while it sends
  progress, so a listening call returns after 25 minutes and Claude starts another; five quiet ones in a row (about two
  hours) and Claude is told to stop until the person asks.
  Only when nothing is listening is a request pushed as a channel message and fetched with `illuminate_next`. Output is
  validated with the zod schema behind each output schema (`validatorFor` in `schemas.ts`) and problems go back to
  Claude. The session's own tools are used, so read-only and the secret guard are instructions there, not enforced.
  A session started without `--dangerously-load-development-channels` drops that push without telling anyone, so a
  request nobody picks up says so on the map after 30 s and fails after 5 min (`NOT_PICKED_UP`, `NEVER_PICKED_UP`).
- **Codex** (`host.ts`; the client names itself `codex-mcp-client` in `initialize`, read with `getClientVersion()`):
  the same channel, with what differs decided per call. Codex can't background a call or be woken, so there is no
  `illuminate_listen` (not listed); a question about an open map is asked in the Codex chat and comes in through
  `illuminate_ask`, which takes the map from the page's URL (else the page that reported last, `lastSeen`), adds what
  is selected there and starts the same `startAsk` as the map's own box (`askFromChat` in `server.ts`). The reply
  belongs in the Codex chat: once the answer is checked and lit on the map, Codex gets it back to post (`chatReply` in
  `reply.ts`: the reply, the lines its notes point at read again now as numbered code blocks, and a word about a fix
  waiting on the map), and the page's conversation column only shows answers with something to do there, a fix or an
  offer (`answersOnPage` in `viewer/src/asking.ts`). The page tells
  the server what is selected and which walkthrough stop is on screen (`PUT /api/maps/<id>/selection`, debounced,
  memory only) and names its map on the WebSocket (`?m=`). Calls wait at most 40 s (Codex's tool timeout is 60 s by
  default); `illuminate_next` is how Codex keeps waiting, and how work started on the page gets picked up ("carry on
  with illuminate"). A request longer than about 28k characters comes in parts (`partsOf`, `illuminate_more`), since
  Codex cuts tool output at about 10k tokens. No system browser: Codex is told to open the link in its built-in browser
  (ChatGPT desktop app), and port 4317 is kept when free, then the next ones, so the browser asks once. The page gets
  `agent: { name, asks: 'chat' }` and its question box says to ask in the Codex chat (`viewer/src/asking.ts`). Tools
  carry annotations (`destructiveHint: false`, `openWorldHint: false`, `readOnlyHint` only where true) so Codex
  doesn't ask before each call. One instructions text covers both agents, since it is sent before the client is known.
  `PREVIEW_AGENT=codex npm run preview` shows the page as in Codex.
- **Proposals** (`Proposal` in `core/src/format.ts`, `asProposal` in `core/src/check.ts`): asked how something would
  change, Claude draws the code as it is and the change on top (`PROPOSAL_RULES` in `prompts.ts`). An addition is
  `pending` until the facts show its `symbol`, call, request or import, then `done` and simply confirmed; a change or
  removal is `pending` while its cited code is there and `done` once it isn't. So re-checking the same map after the
  agent builds the change shows what got built, with nothing stored. A proposal the code already settles when the map
  is being written (`settledProposals`) was misread: the maker sends it back and the explainer doesn't draw it. In an
  answer, new proposed boxes go in `add` and existing ones are marked through `propose`. A `then` arrow or a box with
  no `symbol` can't be detected as built and stays proposed. A sketch element may be `proposed`, and the checker drops that mark once the file has its text.
- **Changes** (`since` and `removed` in `core/src/format.ts`, `core/src/base.ts`, `server/src/changes.ts`,
  `CHANGE_RULES` in `prompts.ts`): asked what a change did, Claude draws the code as it is now and sets `since` to the
  commit to compare with ("HEAD" for work not committed yet). The maker pins that to a full hash (`pinned` in
  `maker.ts`), so the map shows the same change after a commit. `check()` reads the old version through git
  (`createBaseReader`: same secret and path rules, nothing checked out) and puts `change` on each claim: a box that
  names a function is `added` if the function wasn't there and `changed` if its signature or body hash differs (with
  the lines, `lineDiff`); a box that names none goes by its cited lines; an arrow is `added` when the facts didn't
  show it then, or a line that proves it is new. A `removed` box or arrow cites the code as it was, and is confirmed
  only if it checks out against the old version and is gone now. The head start lists what differs from the last
  commit, by file and function (`recentChanges`), which is how the CLI's Claude, with no shell, knows where to look.
  The comparison is with a commit, so it can't tell who made a change: uncommitted work from before a task counts
  too. The viewer draws a key on the map with a Before / After / Both switch (`ChangeKey` in `graph.tsx`): Both is
  the code now with removed parts drawn in; Before and After draw what isn't in that version as a shadow (a faint dashed outline, class `ghost`), so no box moves and the map keeps its shape. Claude is
  told to draw the unchanged steps the change plugs into, so the change reads against something.
  `npm run preview` makes a change to its copy and maps it for a question with "changed" in it.
- **Journeys** (`JOURNEY_RULES` in `prompts.ts`, `view: 'journey'` in the format, `layoutJourney` in `viewer/src/layout.ts`,
  `JourneyNode` in `graph.tsx`): asked what a person sees or goes through, Claude draws only screens, actions and
  choices (`kind`: `screen`, `action`, `choice`), with whatever runs behind a screen folded into one arrow. Every box
  and arrow still cites code and is checked the same. The viewer draws it as a user flow: one line left to right, no
  area boxes (a stage's name sits over its first box), a diamond for a choice, a pill for an action, and no code on
  the boxes (select one to see it). A journey is one main path with branches: a box or arrow off the main path names
  its `branch` in the person's words (none = main path; drawing only, the checker ignores it). With any branch,
  `layoutBranches` puts the main path on one straight line that never wraps, each branch below the step it leaves
  from (starting halfway to the next step, so arrows from later steps pass between its boxes), stacked without
  overlapping, and works out every arrow's path (`routes`). Branches get one of five colours (`journey.css`) in the
  order they leave the main path, with a key at the top left under the change key. Without branches the old layout
  is used unchanged. `npm run preview` returns the journey fixture (`care-app.journey.json`, three branches) for a
  question with "journey" or "go through" in it, or set `PREVIEW_QUESTION`.
- **Timelines** (`TIMELINE_RULES` in `prompts.ts`, `view: 'timeline'` in the format, `layoutLanes` in
  `viewer/src/layout.ts`): Claude's call, like a journey, for parties that take turns where the order between them is
  the point (a handshake, a login through an outside service, a payment and its webhook, a swap across chains). Each
  area is a lane across the whole map, one under the other, and each box sits in its area's lane, in its column in
  time (`timeColumns`: how many steps after the start it is, following the arrows; loops are broken where they turn
  back, so only an arrow that goes back points left). A flow that comes back to a place reads in order instead of
  zigzagging, which the area layout can't avoid. Boxes in one lane are joined side to side, and labels wrap to fit
  between them (`.lanes .link-label`). Not used for one-way flows (the area layout already reads in order, and lanes
  only make the map wider) or for maps built around one function that calls the rest (arrows there say who calls
  whom, not when).
- **Screens** (`core/src/screens.ts`, `server/src/screens.ts`, `viewer/src/screen.tsx`): a box may carry an optional
  `screen`, and the model decides when one helps (`SCREEN_RULES` in `prompts.ts`). The usual one is a `wireframe`:
  the map defines each page once in `pages` (regions in five fixed slots: top, left, main, right, bottom; each region
  names its file and a few elements), and a box shows its page with its own region and element marked. `checkPage`
  confirms each region's file is the page's file or one it imports (however many steps) and that every element's
  text is in that file; a region that fails is left off. Which slot a region is in can't be checked, so the drawing
  says the layout is approximate. Nothing has to be running for a wireframe. In a box's bubble it is laid out at a
  page's width and scaled to fit, like a thumbnail (`FitWireframe` in `screen.tsx`; dragging the bubble wider grows it
  up to full size), and its styles are in `viewer/src/wireframe.css`. The
  walkthrough bubble shows no pictures: the boxes it lights up carry theirs. The other kinds: `capture` (a screenshot
  illuminate took itself with the installed Chrome, headless, clean profile, only of localhost pages or HTML files in
  the repo; saved with a record under `.illuminate/screens/`), `image` (a repo image the cited code names) and `sketch`
  (one component's visible things as a list, every element's text in its markup file; now only asked for on proposals,
  where it can show elements that aren't there yet). `check()` reports them under `report.screens`, not as
  claims: a screen that fails is not shown, and the box stays. The channel offers `illuminate_screens` (what the repo
  can show) and `illuminate_capture` (returns the image for Claude to look at). illuminate never starts the app. The
  CLI's Agent SDK session has no capture tool yet, so there it can only use `image` and `sketch`.
- **Code** (`core/src/code.ts`, `viewer/src/code.tsx`, `code.css`, `editor.ts`): selecting a box or arrow shows its
  code in its bubble, once "Show the code" is opened: the function it names, or the one its cited line is in (whole when short, the lines around the
  citation when long, plain lines for a language the facts don't parse), with cited lines marked. `codeOf` builds it
  on request (`GET /api/maps/<id>/code?item=`), locating lines with the checker's own `checkEvidence`, and
  `when=before` reads the commit a map of a change is compared with. Citation chips open the code at their line (and close it again; there's no separate show/hide link). An answer
  adds to the map only when seeing it drawn helps answer the question; Claude decides (there is no expand button). And each
  block links to the person's editor (`vscode://file/…:line`; the choice is kept in localStorage), so illuminate
  never has to be an editor. An answer may carry `notes` (a citation plus a sentence about that line, `RawNote` in
  `schemas.ts`): `checkNotes` keeps the ones whose line is found when the answer comes in, and `codeForNotes` checks
  them again each time they are shown under the reply. Nothing about code is stored except those notes.
- **Updates** (`server/src/updates.ts`): the release build stamps the version in (`__ILLUMINATE_VERSION__`); a checkout
  has none and never checks. Otherwise illuminate asks npm for the latest version at most once a day (cached in
  `~/.cache/illuminate/`, off with `ILLUMINATE_NO_UPDATE_CHECK` or in CI) and says a newer one at most once a day: the
  channel adds it to the first `illuminate_map` result for Claude to mention (the plugin starts it with `--via plugin`, so
  Claude offers the two plugin commands and runs them only if the person says yes), the CLI prints it. It never updates
  anything itself. Claude Code's own plugin auto-update is off by default for third-party marketplaces; the README says
  how to turn it on.
- **Fix** (`fixes.ts`): `proposeFix` records file hashes → `applyFix` writes only if they still match →
  `connectAfterFix` draws the new edge and closes the gaps it fills → `undoFix`.
- **Serve** (`server.ts`, `store.ts`): maps persist as `<repo>/.illuminate/maps/<id>.json`, with their answers and where
  each fix stands. Jobs and Undo data (the files before a fix) are in memory only. Binds 127.0.0.1, requires a token,
  checks Host and Origin; the viewer gets job progress over the WebSocket. Open WebSockets also count as open tabs: with `autoStop` (the CLI and the channel set it; the channel
  after 5 s) the server stops itself once none are open and no job is running, and `POST /api/stop` is the page's Stop
  button. Tabs learn it stopped from WebSocket close code 4000 (`STOPPED_CLOSE_CODE`), so every page must keep one
  open; they then try `window.close()` (browsers allow it only for a tab with one page of history) and otherwise say
  illuminate stopped. In the channel, a stopped page server ends any listening call (Claude is told not to listen
  again until asked), and the MCP server stays connected so the next illuminate call starts a new page server.
- Server tests use `scriptedAgent` and `copyCareApp` from `packages/server/test/helpers.ts`; follow that pattern
  rather than mocking the SDK.
