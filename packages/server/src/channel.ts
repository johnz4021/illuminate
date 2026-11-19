// illuminate as a Claude Code channel: an MCP server Claude Code starts over stdio, so the person's own Claude Code
// session does the reading and writing (on their own sign-in) instead of a separate Agent SDK session with its own key.
//
// The local illuminate server runs inside this process with a bridge `Agent` (bridge.ts). Work reaches Claude in tool
// results, so no channel flag is needed:
// - `illuminate_map` and `illuminate_submit` wait for the next request, so making a map (draft, check, repair) runs
//   within one turn;
// - between turns Claude keeps one `illuminate_listen` call open. Claude Code moves a call that runs past two minutes
//   to the background and gives the person their terminal back; when they ask on the map, the call returns with the
//   request and Claude Code wakes the session with it. Claude Code drops a call that has been quiet for 30 minutes,
//   even one sending progress notifications (seen in a live session: dropped after 1841 s), so a listening call
//   returns on its own before then and Claude starts another; after about two hours with no questions it stops.
// A session started with `--dangerously-load-development-channels server:illuminate` also gets a channel message when
// work arrives and nothing is listening (then Claude calls `illuminate_next`).
// Only the person's browser can start work, and the page needs illuminate's token.
// Channels: https://code.claude.com/docs/en/channels-reference · long-running MCP calls: https://code.claude.com/docs/en/mcp
//
// Codex starts the same server (it names itself in the initialize request; host.ts), and there it works differently:
// - no listening: Codex can't background a call or be woken, so a question about the map is asked in the Codex chat
//   and comes in through `illuminate_ask`, which takes what is selected on the page and waits for the answer's request
//   like `illuminate_map` does;
// - no call waits longer than about 40 s (Codex's tool timeout), and `illuminate_next` is how Codex carries on waiting;
// - a request longer than Codex keeps of a tool result comes in parts (`illuminate_more`);
// - the map isn't opened in the system browser: Codex is told to open the link in its built-in browser (the desktop
//   app's), beside the chat, and the page's question box points to the chat instead.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ServerNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { createBridge, type Bridge, type BridgeRequest } from './bridge';
import { openBrowser } from './browser';
import type { Answer } from './explainer';
import { hostOf, type AgentHost } from './host';
import { capture, listScreens, type Shooter } from './screens';
import { startServer, type IlluminateServer, type ServerEvent } from './server';
import { createStore } from './store';
import { VERSION, checkForUpdate, updateMessage, type InstalledVia, type Newer } from './updates';

export type ChannelOptions = {
  /** The repo maps are about unless a tool call names another (Claude Code passes CLAUDE_PROJECT_DIR). */
  root: string;
  /** How a link is opened in the browser (tests pass a no-op). */
  open?: (url: string) => void;
  /** How long `illuminate_map` and `illuminate_submit` wait for what comes next before handing the turn back (default 90 s; 40 s in Codex). */
  waitMs?: number;
  /** In Codex, the longest text one tool result carries before a request is split into parts (default 28,000 characters). */
  partChars?: number;
  /** How a page is screenshotted (tests pass a stand-in for the browser). */
  shoot?: Shooter;
  /** How often a waiting call sends progress (default 30 s). */
  heartbeatMs?: number;
  /** How long one `illuminate_listen` call waits before returning so Claude can start another (default 25 min). */
  listenMs?: number;
  /** How many quiet listening calls in a row before illuminate stops listening (default 5, about two hours). */
  quietListens?: number;
  /** How long after the last illuminate tab closes the page's server stops (default 5 s, enough for a reload). */
  afterLastTabMs?: number;
  /** Port for the local server (default 4317, or the next free one). */
  port?: number;
  /** How illuminate was installed (the plugin passes `--via plugin`), which decides how an update is suggested. */
  via?: InstalledVia;
  /** Whether a newer version is out (default: ask npm, at most once a day; tests pass a stand-in). */
  checkUpdate?: () => Promise<Newer | null>;
};

// One text for every client: the instructions are sent before illuminate knows which agent connected, so the parts that
// differ are said for each (and the tool results, which do know, say the rest).
export const CHANNEL_INSTRUCTIONS = [
  'illuminate draws checked, interactive maps of how this codebase works, in the person\'s browser. You do the reading and writing; illuminate checks every claim against the code before it shows anything.',
  '- When the person asks how something works across files ("what happens when…", "how does X reach Y", "what did this change do"), what someone sees or goes through in the app (a user journey), or how a change would look before it\'s made ("how would we add…", "plan…"), or asks for a map, diagram or walkthrough, call illuminate_map with their question in their own words.',
  '- A map can hold proposals: boxes and arrows that aren\'t in the code yet, or that would change or go, drawn on top of the code as it is. The request explains how. illuminate works out from the code which proposals are done, so after you build a change you proposed on a map, the person can reopen that map to see it.',
  '- A map can show a change that was made: "what did you just change?", "what did the last commit do?". The request explains how. You draw the code as it is now and name the commit to compare with; illuminate works out from the two versions what is new, different or gone. Use it when the person wants to see what a task changed.',
  '- illuminate gives you work as requests in tool results. Each request says what to do and the JSON to return. Explore the code with Read, Grep and Glob, then call illuminate_submit with the request_id and your output. If the result holds another request, do that one too. If you can\'t finish one, call illuminate_fail.',
  '- A picture of the screen can ground a map for people who don\'t read code. Use your judgement: when a flow starts from something the person sees (a button, a form, a page) a screen on that box helps; for backend-only questions leave screens out. illuminate_screens lists what this repo can show; illuminate_capture screenshots a page already running on this machine, or an HTML file in the repo, and shows you the result. Look at it before using it: if it shows a login page, an error or the wrong state, don\'t use it. Never start the app yourself to get a screenshot. When nothing is running, a map can still show a wireframe of the page drawn from the code; the request explains how.',
  '- While working on an illuminate request, don\'t edit files or run commands that change anything, and never read secret files (.env, keys). A fix is only proposed; illuminate applies it after the person approves it on the map.',
  '- Answers are shown on the map. In the chat or terminal, say at most a sentence or two.',
  'In Claude Code:',
  '- Once a map is ready or an answer is shown, call illuminate_listen and leave it running. It moves to the background, so the person keeps their terminal. When they ask something on the map it returns with a request: do it, submit it, then call illuminate_listen again. If it returns saying nothing was asked yet, call it again without telling the person. Only one is needed at a time.',
  '- If an illuminate channel message arrives instead, call illuminate_next to get the request.',
  'In Codex (no illuminate_listen there):',
  '- Pass `repo`, the absolute path of the project, to illuminate_map and illuminate_open. Give the person the map\'s link, and if you have a built-in browser, open it there so the map sits beside the chat.',
  '- While a map is open and the person asks about it in the chat (the map, a box or arrow, what they selected, a walkthrough step), call illuminate_ask with their question and the page\'s current URL if you know it. illuminate adds what they selected on the page.',
  '- A long request comes in parts: read every part with illuminate_more before you start. If a result says illuminate is still working, or the person says to carry on with illuminate, call illuminate_next.',
].join('\n');

/**
 * Tool annotations. Codex asks the person before each MCP tool call unless a tool says it only reads, or that it
 * neither destroys anything nor reaches outside this machine (openai/codex `mcp_tool_call.rs`). illuminate's tools
 * write only under `.illuminate/` and talk only to this machine, so they say so; `readOnlyHint` only where it's true.
 */
const local = (title: string, readOnly = false) => ({ title, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: false, openWorldHint: false });

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown>; annotations: ReturnType<typeof local> };

const TOOLS: ToolDef[] = [
  {
    name: 'illuminate_map',
    description: 'Make a checked map that answers a question about how this codebase works, and open it in the person\'s browser. Returns the first piece of work for you to do.',
    annotations: local('Make a map'),
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: 300, description: 'The person\'s question, in their own words (300 characters at most).' },
        repo: { type: 'string', description: 'The repo root, if not the project Claude Code was started in.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'illuminate_next',
    description: 'Get the next piece of work illuminate has for you (after an illuminate channel message).',
    annotations: local('Get the next request', true),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'illuminate_submit',
    description: 'Hand in your output for an illuminate request. It is checked; if it can\'t be read you get the problems back to fix. Returns the next piece of work, if there is one.',
    annotations: local('Hand in a request'),
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        output: { type: 'object', description: 'JSON matching the request\'s schema.' },
      },
      required: ['request_id', 'output'],
    },
  },
  {
    name: 'illuminate_fail',
    description: 'Give up on an illuminate request, saying why in plain words. The person sees it on the map.',
    annotations: local('Give up on a request'),
    inputSchema: {
      type: 'object',
      properties: { request_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['request_id', 'reason'],
    },
  },
  {
    name: 'illuminate_listen',
    description: 'Wait for the next question the person asks on the map (or a new map they start there). Keep one running whenever you have no illuminate work: it moves to the background, and returns with a request when they ask. Do the request, submit it, then call this again.',
    annotations: local('Listen to the map', true),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'illuminate_screens',
    description: 'List what this repo can show of its screens: local pages being served right now, HTML files, preview setups and image files. Costs nothing; call it when a picture of the screen might help a map or an answer.',
    annotations: local('List screens', true),
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
  },
  {
    name: 'illuminate_capture',
    description: 'Screenshot one page so it can be a box\'s `screen` on a map: a `url` served on this machine (http://localhost:…), or an HTML `file` in the repo. Returns the image for you to look at, the labelled things visible on it, and the capture id to put in the box\'s `screen`. Runs in a clean browser profile, so pages behind a login show their login page.',
    annotations: local('Screenshot a local page'),
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A page on this machine, e.g. http://localhost:3000/patients' },
        file: { type: 'string', description: 'Or: a repo-relative .html file' },
        repo: { type: 'string' },
      },
    },
  },
  {
    name: 'illuminate_open',
    description: 'Open saved maps in the person\'s browser: one map, or the list of all of them. Returns the maps saved in the repo.',
    annotations: local('Open saved maps'),
    inputSchema: {
      type: 'object',
      properties: {
        map_id: { type: 'string', description: 'A saved map\'s id; leave out for the list.' },
        repo: { type: 'string' },
      },
    },
  },
];

/** Codex's own tools, and how the shared ones read there. */
const CODEX_TOOLS: Record<string, Partial<ToolDef>> = {
  illuminate_map: {
    description: 'Make a checked map that answers a question about how this codebase works. Returns the map page\'s link to give the person (open it in your built-in browser if you have one) and the first piece of work for you to do.',
  },
  illuminate_next: {
    description: 'Get the next piece of work illuminate has for you, waiting up to 40 seconds for it. Call it when a result says illuminate is still working, or when the person says to carry on with illuminate.',
  },
  illuminate_open: {
    description: 'Get the link to saved maps: one map, or the list of all of them, to open in your built-in browser or give the person. Returns the maps saved in the repo.',
  },
};
const CODEX_ONLY: ToolDef[] = [
  {
    name: 'illuminate_ask',
    description: 'Ask illuminate a question the person asked in this chat about an illuminate map that is open in the browser. illuminate adds what they have selected on the page and starts the answer; returns the first piece of work for you to do. The answer is shown on the map.',
    annotations: local('Ask about the open map'),
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: 2000, description: 'The person\'s question, in their own words.' },
        url: { type: 'string', description: 'The map page\'s current URL in the browser (http://127.0.0.1:…/m/…), if you know it.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'illuminate_more',
    description: 'Read the next part of an illuminate request that came in parts. Read every part before you start on it.',
    annotations: local('Read the rest of a request', true),
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        part: { type: 'number', description: 'Which part (2 for the second). Leave out for the next one.' },
      },
      required: ['request_id'],
    },
  },
];

/** The tools as this agent sees them: in Codex, no listening, and two tools of its own. */
export function toolsFor(host: AgentHost): ToolDef[] {
  if (host.id !== 'codex') return TOOLS;
  // The folder Codex starts illuminate in isn't always the project's, so Codex is asked to name the repo.
  const withRepo = (t: ToolDef): ToolDef => {
    const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
    if (!props.repo) return t;
    return { ...t, inputSchema: { ...t.inputSchema, properties: { ...props, repo: { type: 'string', description: 'The absolute path of the repo you are working in. Pass it every time.' } } } };
  };
  const shared = TOOLS.filter((t) => t.name !== 'illuminate_listen').map((t) => withRepo({ ...t, ...CODEX_TOOLS[t.name] }));
  const at = shared.findIndex((t) => t.name === 'illuminate_fail') + 1;
  return [...shared.slice(0, at), ...CODEX_ONLY, ...shared.slice(at)];
}

/** A request as Claude reads it: what it's for, how to answer, the prompt, and the output schema. */
export function requestText(r: BridgeRequest): string {
  return [
    `## illuminate request ${r.id}: ${r.label}`,
    '',
    `When you're done, call illuminate_submit with request_id "${r.id}" and \`output\`: a JSON object matching the schema at the end. Don't edit any files.`,
    r.tools.length ? '' : 'Answer from what is in this request alone. Don\'t read the code for this one.',
    r.continues ? 'This follows on from your earlier work for illuminate in this conversation.' : '',
    '',
    '---',
    r.prompt,
    '---',
    '',
    '## Output schema (JSON Schema)',
    JSON.stringify(r.schema),
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

/**
 * A long text cut into parts of at most `max` characters, at line ends where it can be (a line longer than a part,
 * such as a big output schema, is cut where it must be). Joined back with newlines it is the text again, apart from
 * where a long line was cut.
 */
export function partsOf(t: string, max: number): string[] {
  const parts: string[] = [];
  let cur: string | null = null;
  for (const line of t.split('\n')) {
    let rest = line;
    while (rest.length > max) {
      if (cur !== null) parts.push(cur);
      cur = null;
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    if (cur !== null && cur.length + 1 + rest.length > max) {
      parts.push(cur);
      cur = null;
    }
    cur = cur === null ? rest : `${cur}\n${rest}`;
  }
  if (cur !== null) parts.push(cur);
  return parts;
}

type Extra = { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: ServerNotification) => Promise<void> };
type Text = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
const text = (t: string, isError = false): Text => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

const CLOSED = 'The person closed illuminate, so there is nothing to listen to. Don\'t call illuminate_listen again unless they ask for a map or ask you to listen. Say nothing to the person about this.';
/** The port a page server asks for first. In Codex a steady port means the browser asks to allow it only once. */
const PORT = 4317;

export function createChannel(o: ChannelOptions) {
  const open = o.open ?? openBrowser;
  /** Who is on the other end, from the client info it sent when it connected (Claude Code until then). */
  const host = (): AgentHost => hostOf(mcp.getClientVersion());
  const codex = () => host().id === 'codex';
  const waitMs = () => o.waitMs ?? host().waitMs;
  const partChars = o.partChars ?? 28_000;
  const heartbeatMs = o.heartbeatMs ?? 30_000;
  const listenMs = o.listenMs ?? 25 * 60_000;
  const quietListens = o.quietListens ?? 5;
  /** Listening calls in a row that ended with no question. Any other illuminate call starts the count again. */
  let quiet = 0;
  const servers = new Map<string, Promise<IlluminateServer>>();
  /** Listening calls to end when the person closes illuminate (Stop, or the last tab). */
  const closedListeners = new Set<() => void>();
  /** Listeners for "something finished", so a waiting tool call can say so. */
  const finished = new Set<(message: string) => void>();
  const lastReport = new Map<string, { confirmed: number; claims: number; hidden: string[] }>();
  /** The latest answer on each map, so Codex can be told when it offered a new map. */
  const lastAnswer = new Map<string, Answer>();
  /** Requests that came in parts (Codex), and the next part to hand over. */
  const parts = new Map<string, { parts: string[]; next: number }>();
  // A newer version is mentioned once, with the first map of the session, if the check answers within a moment.
  let updateChecked = false;
  const updateNote = async (): Promise<string | null> => {
    if (updateChecked) return null;
    updateChecked = true;
    const newer = await Promise.race([(o.checkUpdate ?? checkForUpdate)(), new Promise<null>((r) => setTimeout(() => r(null), 1500).unref?.())]);
    return newer ? updateMessage(newer, o.via ?? 'mcp', host().id) : null;
  };

  const mcp = new Server(
    { name: 'illuminate', version: VERSION ?? '0.0.0-dev' },
    { capabilities: { experimental: { 'claude/channel': {} }, tools: {} }, instructions: CHANNEL_INSTRUCTIONS },
  );
  const bridge: Bridge = createBridge({
    host,
    announce: (r) => {
      // Codex drops notifications it doesn't know; the map page tells the person what to say instead.
      if (codex()) return;
      void mcp
        .notification({
          method: 'notifications/claude/channel',
          params: { content: `illuminate has work for you: ${r.label}. Call illuminate_next to get it.`, meta: { request_id: r.id } },
        } as unknown as ServerNotification)
        .catch(() => {});
    },
  });

  /** A request as a tool result. In Codex, one too long for a tool result comes in parts, the rest with illuminate_more. */
  const deliver = (r: BridgeRequest, after = ''): string => {
    const whole = `${requestText(r)}${after ? `\n\n${after}` : ''}`;
    if (!codex() || whole.length <= partChars) return whole;
    const all = partsOf(whole, partChars);
    parts.set(r.id, { parts: all, next: 1 });
    return partText(r.id, 0, all);
  };
  const partText = (id: string, i: number, all: string[]) =>
    [
      `[illuminate request ${id}, part ${i + 1} of ${all.length}.${i + 1 < all.length ? ` Call illuminate_more with request_id "${id}" for part ${i + 2} before you start; the output schema is at the end of the last part.` : ' This is the last part.'}]`,
      '',
      all[i] ?? '',
    ].join('\n');

  const rootOf = (repo: unknown): string => {
    const dir = path.resolve(o.root, typeof repo === 'string' && repo.trim() ? repo : '.');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`No such folder: ${dir}`);
    return fs.realpathSync(dir);
  };

  const serverFor = (root: string): Promise<IlluminateServer> => {
    let s = servers.get(root);
    if (!s) {
      s = startServer({
        root,
        port: o.port ?? PORT,
        agent: bridge.agent,
        page: host().page,
        // Stop, or closing the last tab, stops the page's server and ends listening. The MCP server itself stays
        // connected, so the next illuminate tool call starts a new page server.
        autoStop: { afterLastTabMs: o.afterLastTabMs ?? 5_000 },
        onStop: () => {
          servers.delete(root);
          if (!servers.size) for (const l of [...closedListeners]) l();
        },
        onEvent: (e) => void onEvent(root, e),
      });
      s.catch(() => servers.delete(root));
      servers.set(root, s);
    }
    return s;
  };

  /** In Codex, said with a link: the port it is on, when that isn't the usual one. */
  const portNote = (s: IlluminateServer) =>
    codex() && (o.port ?? PORT) === PORT && s.port !== PORT
      ? `illuminate is on port ${s.port} this time, since ${PORT} was taken, so the browser may ask again whether to open it.`
      : '';
  /** In Codex, how to show the person a map. */
  const showInCodex = (url: string) =>
    `Give the person this link: ${url}\nIf you have a built-in browser, open the link there, so the map sits beside this chat; don't open it in another browser.`;

  async function onEvent(root: string, e: ServerEvent) {
    if (e.type === 'map') lastReport.set(e.mapId, {
      confirmed: e.report.summary.confirmed,
      claims: e.report.summary.claims,
      hidden: Object.entries(e.report.screens ?? {}).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `${id} (${c.reasons.join('; ')})`),
    });
    if (e.type === 'answer') lastAnswer.set(e.mapId, e.answer);
    if (e.type !== 'job' || e.status === 'started') return;
    const listen = codex() ? '' : 'Then call illuminate_listen so questions they ask on the map reach you.';
    let message: string;
    if (e.status === 'failed') message = [`illuminate couldn't finish "${e.question}": ${e.error ?? 'unknown error'}`, listen].filter(Boolean).join('\n');
    else if (e.job === 'make') {
      const s = await servers.get(root);
      const r = lastReport.get(e.mapId);
      message = [
        `The map for "${e.question}" is ready${r ? `: ${r.confirmed} of ${r.claims} claims confirmed against the code` : ''}.`,
        r?.hidden.length ? `Screens left out because they didn't check out: ${r.hidden.join(', ')}.` : '',
        s ? (codex() ? showInCodex(s.pageUrl(e.mapId)) : `It's open in the browser: ${s.pageUrl(e.mapId)}`) : '',
        codex()
          ? 'Tell the person in a sentence; the map does the explaining. They can take the walkthrough, or click a box or arrow on the map and ask about it here in the chat (then call illuminate_ask).'
          : 'Tell the person in a sentence; the map does the explaining. They can take the walkthrough, or select any box and ask about it there.',
        listen,
      ].filter(Boolean).join('\n');
    } else if (codex()) {
      const a = lastAnswer.get(e.mapId);
      const offer = a?.offer?.status === 'pending' ? a.offer : null;
      message = offer
        ? `That question is about a different part of the app than this map shows. The map offers ${offer.existing ? `the map that already covers it ("${offer.existing.question}"), or ` : ''}a new map for "${offer.question}". Ask the person in a sentence whether they want a new map; if they do, call illuminate_map with that question.`
        : `The answer to "${e.question}" is shown on the map, in the conversation beside it. In the chat, say at most a sentence or two.`;
    } else message = `The answer to "${e.question}" is shown on the map. Call illuminate_listen again for their next question.`;
    for (const f of [...finished]) f(message);
  }

  /**
   * Progress notifications while a call waits. Claude Code's docs say they count as activity, but a backgrounded call
   * was still dropped after 30 quiet minutes, so `illuminate_listen` also returns on its own (see the top of the file). Only possible when
   * the call came with a progress token. Returns the function that stops them.
   */
  function keepAlive(extra: Extra): () => void {
    const token = extra._meta?.progressToken;
    if (token === undefined) return () => {};
    let progress = 0;
    const beat = setInterval(() => {
      void extra
        .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: 'Waiting for the map' } })
        .catch(() => {});
    }, heartbeatMs);
    beat.unref?.();
    return () => clearInterval(beat);
  }

  /** After handing something in: the next request, or what finished, or (after a while) that nothing is needed yet. */
  async function whatNext(extra: Extra): Promise<Text> {
    const ac = new AbortController();
    const stop = keepAlive(extra);
    const onAbort = () => ac.abort();
    extra.signal.addEventListener('abort', onAbort, { once: true });
    let onFinish: ((m: string) => void) | null = null;
    const done = new Promise<string>((resolve) => {
      onFinish = resolve;
      finished.add(resolve);
    });
    const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs()).unref?.());
    try {
      const winner = await Promise.race([
        bridge.waitForNext(ac.signal).then((r) => (r ? { request: r } : null)),
        done.then((message) => ({ message })),
        timer,
      ]);
      if (winner && 'request' in winner) return text(deliver(winner.request));
      if (winner && 'message' in winner) return text(winner.message);
      // Codex can't wait in the background, so it carries on with another short wait.
      if (codex()) return text('illuminate is still working on its side. Call illuminate_next to carry on: it waits for what comes next.');
      return text('illuminate is still working on its side. Call illuminate_listen: it returns when there is something for you.');
    } finally {
      stop();
      extra.signal.removeEventListener('abort', onAbort);
      ac.abort();
      if (onFinish) finished.delete(onFinish);
    }
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(host()).map((t) => ({ ...t })) as never }));

  /**
   * The page a question in Codex's chat is about: the server and map its URL names, if it names one of illuminate's;
   * else the map whose page was used last, on any server running.
   */
  async function pageFor(url: unknown): Promise<{ server: IlluminateServer; mapId: string | null } | null> {
    const running = (await Promise.all([...servers.values()].map((s) => s.catch(() => null)))).filter((s): s is IlluminateServer => !!s);
    let at: URL | null = null;
    try {
      at = typeof url === 'string' && url ? new URL(url) : null;
    } catch {
      at = null;
    }
    const named = at && ['127.0.0.1', 'localhost'].includes(at.hostname) ? running.find((s) => String(s.port) === at.port) : undefined;
    if (named && at) return { server: named, mapId: /^\/m\/([a-z0-9-]{1,80})\/?$/.exec(at.pathname)?.[1] ?? null };
    const latest = running
      .map((server) => ({ server, seen: server.lastSeen() }))
      .filter((x) => x.seen)
      .sort((a, b) => b.seen!.at - a.seen!.at)[0];
    return latest ? { server: latest.server, mapId: null } : null;
  }

  mcp.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<Text> => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (req.params.name !== 'illuminate_listen') quiet = 0;
    try {
      switch (req.params.name) {
        case 'illuminate_map': {
          const question = String(args.question ?? '').trim();
          if (!question) return text('Pass the person\'s question.', true);
          const server = await serverFor(rootOf(args.repo));
          const id = server.startMap(question);
          // The job runs asynchronously, so listening now misses neither the first request nor an early failure.
          const next = whatNext(extra);
          const url = server.pageUrl(id);
          // In Codex the map goes beside the chat, in its built-in browser, which Codex opens; not the system browser.
          if (!codex()) open(url);
          const [first, update] = await Promise.all([next, updateNote()]);
          const opening = codex()
            ? [`The map is being made. ${showInCodex(url)} The person can watch it being drawn while you work.`, portNote(server)].filter(Boolean).join('\n')
            : `The map is opening in the browser: ${url}\nTell the person, and give them the link in case the tab didn't appear.`;
          return {
            ...first,
            content: [
              { type: 'text', text: `${opening}\n` },
              ...first.content,
              ...(update ? [{ type: 'text' as const, text: update }] : []),
            ],
          };
        }
        case 'illuminate_ask': {
          const question = String(args.question ?? '').trim();
          if (!question) return text('Pass the person\'s question.', true);
          const page = await pageFor(args.url);
          if (!page) return text('No illuminate map is open right now. To answer from a map, make one with illuminate_map, or open a saved one with illuminate_open.', true);
          const asked = page.server.askFromChat(question, page.mapId);
          // The answer runs asynchronously, so waiting now misses neither its first request nor an early failure.
          const first = await whatNext(extra);
          const about = asked.selected.length ? ` about ${asked.selected.map((n) => `"${n}"`).join(', ')} (selected on the page)` : '';
          return { ...first, content: [{ type: 'text', text: `Asked on the map "${asked.mapId}"${about}.\n` }, ...first.content] };
        }
        case 'illuminate_more': {
          const id = String(args.request_id ?? '');
          const got = parts.get(id);
          if (!got) return text(`Request "${id}" didn't come in parts, or isn't waiting any more.`, true);
          const want = typeof args.part === 'number' ? Math.trunc(args.part) - 1 : got.next;
          if (want < 0 || want >= got.parts.length) return text(`Request ${id} has parts 1 to ${got.parts.length}.`, true);
          got.next = Math.min(want + 1, got.parts.length - 1);
          return text(partText(id, want, got.parts));
        }
        case 'illuminate_listen': {
          // Not offered in Codex: a waiting call there holds up the person's turn.
          if (codex()) return text('illuminate_listen isn\'t used in Codex. When the person asks about the map in the chat, call illuminate_ask.', true);
          if (!servers.size) return text(CLOSED);
          const stop = keepAlive(extra);
          let closed = false;
          const onClosed = () => {
            closed = true;
            ac.abort();
          };
          const ac = new AbortController();
          const onAbort = () => ac.abort();
          extra.signal.addEventListener('abort', onAbort, { once: true });
          const timer = setTimeout(() => ac.abort(), listenMs);
          closedListeners.add(onClosed);
          try {
            const r = await bridge.waitForNext(ac.signal);
            if (r) {
              quiet = 0;
              return text(deliver(r, 'After illuminate_submit, call illuminate_listen again so questions on the map keep reaching you.'));
            }
            if (closed) return text(CLOSED);
            if (extra.signal.aborted) return text('Stopped listening. Questions asked on the map wait until you call illuminate_listen again.');
            quiet++;
            if (quiet >= quietListens) {
              // Claude is told not to listen again on its own; if the person asks it to, that call starts afresh.
              quiet = 0;
              return text('Nobody has asked on the map for about two hours, so illuminate stopped listening. Don\'t call illuminate_listen again unless the person asks you to listen, or asks for a map. Say nothing to the person about this.');
            }
            return text('Nothing was asked on the map yet. Call illuminate_listen again to keep listening, and say nothing to the person about it.');
          } finally {
            closedListeners.delete(onClosed);
            clearTimeout(timer);
            extra.signal.removeEventListener('abort', onAbort);
            stop();
          }
        }
        case 'illuminate_next': {
          const r = bridge.next();
          if (r) return text(deliver(r));
          // In Codex this is also how to keep waiting (calls there can't run long), while illuminate has work going.
          const busy = (await Promise.all([...servers.values()].map((s) => s.then((x) => x.working(), () => false)))).some(Boolean);
          if (codex() && busy) return await whatNext(extra);
          return text('Nothing is waiting right now.');
        }
        case 'illuminate_submit': {
          const id = String(args.request_id ?? '');
          // What follows (a repair round, the check's result) only happens once this handler yields to the event loop,
          // so listening right after submitting misses nothing.
          const r = bridge.submit(id, args.output);
          if (r.ok) {
            parts.delete(id);
            return await whatNext(extra);
          }
          return text(`That output for ${id} can't be used yet. Fix these and call illuminate_submit again:\n${r.problems.map((p) => `- ${p}`).join('\n')}`, true);
        }
        case 'illuminate_fail': {
          parts.delete(String(args.request_id ?? ''));
          const ok = bridge.fail(String(args.request_id ?? ''), String(args.reason ?? 'no reason given'));
          return text(ok ? 'Told the person on the map.' : 'No such request is waiting.');
        }
        case 'illuminate_screens': {
          const root = rootOf(args.repo);
          const port = (await servers.get(root))?.port;
          return text(await listScreens(root, { skipPorts: port ? [port] : [] }));
        }
        case 'illuminate_capture': {
          const root = rootOf(args.repo);
          const target = typeof args.url === 'string' && args.url ? { url: args.url } : typeof args.file === 'string' && args.file ? { file: args.file } : null;
          if (!target) return text('Pass `url` (a page on this machine) or `file` (an .html file in the repo).', true);
          const stop = keepAlive(extra);
          try {
            const r = await capture(root, target, o.shoot);
            if (!r.ok) return text(r.reason, true);
            const c = r.result.capture;
            const labels = [...new Set(c.elements.map((e) => `${e.tag} "${e.text}"`))].slice(0, 40);
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `Captured as ${c.id}${c.title ? ` ("${c.title}")` : ''}. Look at the image below before using it.`,
                    `To show it on a box: "screen": { "kind": "capture", "capture": "${c.id}", "highlight": "<label of the thing this box is about>" }. A highlight must be one of the labels below and also appear in the code the box cites; leave it out if nothing fits.`,
                    '',
                    labels.length ? `Labelled things visible:\n${labels.map((l) => `  - ${l}`).join('\n')}` : 'Nothing labelled is visible on it.',
                    '',
                    // Codex keeps only so much of a tool result, and the image matters more.
                    `Text on the page: ${(codex() ? r.result.text.slice(0, 4000) : r.result.text) || '(none)'}`,
                  ].join('\n'),
                },
                { type: 'image', data: r.result.png.toString('base64'), mimeType: 'image/png' },
              ],
            };
          } finally {
            stop();
          }
        }
        case 'illuminate_open': {
          const root = rootOf(args.repo);
          const server = await serverFor(root);
          const mapId = typeof args.map_id === 'string' && args.map_id ? args.map_id : undefined;
          const url = server.pageUrl(mapId);
          if (!codex()) open(url);
          const maps = createStore(root).list().slice(0, codex() ? 200 : undefined);
          const opened = codex()
            ? [showInCodex(url), portNote(server), 'When the person asks about the map here in the chat, call illuminate_ask.']
            : [`Opened ${url}`, 'Call illuminate_listen so questions asked on the map reach you.'];
          return text([...opened.filter(Boolean), '', maps.length ? 'Saved maps:' : 'No maps saved in this repo yet.', ...maps.map((m) => `${m.id}  ${m.question}`)].join('\n'));
        }
        default:
          return text(`Unknown tool: ${req.params.name}`, true);
      }
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true);
    }
  });

  return {
    mcp,
    bridge,
    async close() {
      for (const s of servers.values()) await s.then((x) => x.close()).catch(() => {});
      servers.clear();
      await mcp.close();
    },
  };
}

/** `illume channel`: serve the channel over stdio until Claude Code closes it. stdout belongs to MCP, so logs go to stderr. */
export async function runChannel(o: Omit<ChannelOptions, 'root'> & { root?: string }) {
  console.log = console.error;
  console.info = console.error;
  const channel = createChannel({ ...o, root: o.root ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd() });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void channel.close().finally(() => process.exit(0));
  };
  channel.mcp.onclose = stop;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await channel.mcp.connect(new StdioServerTransport());
}
