// illuminate as a Claude Code channel, driven the way Claude Code drives it: an MCP client calls the tools, and the
// test plays Claude by submitting output. No model is called.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, parseMap } from '@illuminate/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge, NEVER_PICKED_UP, NOT_PICKED_UP } from '../src/bridge';
import { createChannel, partsOf } from '../src/channel';
import { CODEX, CODEX_CLIENT } from '../src/host';
import { MAP_SCHEMA } from '../src/schemas';
import { CARE_MAP, cleanup, copyCareApp, waitFor } from './helpers';

const parseMapOrThrow = (json: unknown) => {
  const parsed = parseMap(json);
  if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
  return parsed.map;
};

describe('the bridge', () => {
  it('announces a request when nothing is waiting, and hands back output once it reads', async () => {
    const announced: string[] = [];
    const bridge = createBridge({ announce: (r) => announced.push(r.id) });
    const reply = bridge.agent({ prompt: 'Draw it', label: 'Making a map', schema: MAP_SCHEMA, cwd: '/' });
    expect(announced).toEqual(['r1']);
    expect(bridge.next()).toMatchObject({ id: 'r1', label: 'Making a map', continues: false });

    const bad = bridge.submit('r1', { version: 1 });
    expect(bad.ok).toBe(false);
    expect(bridge.submit('r1', JSON.stringify(CARE_MAP))).toEqual({ ok: true });
    await expect(reply).resolves.toMatchObject({ output: CARE_MAP, sessionId: 'claude-code', cost: null });
    expect(bridge.outstanding()).toEqual([]);
    expect(bridge.submit('r1', CARE_MAP).ok).toBe(false);
  });

  it('hands a request to a waiting tool call instead of announcing it, and lets Claude give up', async () => {
    const announced: string[] = [];
    const bridge = createBridge({ announce: (r) => announced.push(r.id) });
    const ac = new AbortController();
    const waiting = bridge.waitForNext(ac.signal);
    const reply = bridge.agent({ prompt: 'Answer', schema: MAP_SCHEMA, cwd: '/', tools: [], resume: 'claude-code' });
    await expect(waiting).resolves.toMatchObject({ id: 'r1', tools: [], continues: true });
    expect(announced).toEqual([]);
    expect(bridge.fail('r1', 'the code is not there')).toBe(true);
    await expect(reply).rejects.toThrow('the code is not there');
  });

  it('says on the map when no one picks a request up, then gives up instead of waiting forever', async () => {
    const said: string[] = [];
    const bridge = createBridge({ announce: () => {}, nudgeMs: 20, giveUpMs: 60 });
    const reply = bridge.agent({ prompt: 'x', schema: MAP_SCHEMA, cwd: '/', onProgress: (p) => said.push(p.text) });
    expect(said).toEqual(['Waiting for Claude Code to pick this up']);
    await waitFor(() => said.length === 2);
    expect(said[1]).toBe(NOT_PICKED_UP);
    await expect(reply).rejects.toMatchObject({ message: NEVER_PICKED_UP, unheard: true });
    expect(bridge.outstanding()).toEqual([]);
  });

  it('keeps waiting once Claude has picked a request up', async () => {
    const said: string[] = [];
    const bridge = createBridge({ announce: () => {}, nudgeMs: 20, giveUpMs: 40 });
    const reply = bridge.agent({ prompt: 'x', schema: MAP_SCHEMA, cwd: '/', onProgress: (p) => said.push(p.text) });
    expect(bridge.next()).toMatchObject({ id: 'r1' });
    expect(said).toEqual(['Waiting for Claude Code to pick this up', 'Claude Code is working on this in your terminal']);
    await new Promise((r) => setTimeout(r, 80));
    expect(said).toHaveLength(2);
    expect(bridge.submit('r1', CARE_MAP)).toEqual({ ok: true });
    await expect(reply).resolves.toMatchObject({ output: CARE_MAP });
  });

  it('hands a request to the newest waiting call, leaving an older listener waiting', async () => {
    const bridge = createBridge({ announce: () => {} });
    const older = new AbortController();
    const newer = new AbortController();
    const listener = bridge.waitForNext(older.signal);
    const current = bridge.waitForNext(newer.signal);
    void bridge.agent({ prompt: 'x', schema: MAP_SCHEMA, cwd: '/' }).catch(() => {});
    await expect(current).resolves.toMatchObject({ id: 'r1' });
    void bridge.agent({ prompt: 'y', schema: MAP_SCHEMA, cwd: '/' }).catch(() => {});
    await expect(listener).resolves.toMatchObject({ id: 'r2' });
  });

  it('drops a waiting tool call once it stops listening', async () => {
    const announced: string[] = [];
    const bridge = createBridge({ announce: (r) => announced.push(r.id) });
    const ac = new AbortController();
    const waiting = bridge.waitForNext(ac.signal);
    ac.abort();
    await expect(waiting).resolves.toBeNull();
    void bridge.agent({ prompt: 'x', schema: MAP_SCHEMA, cwd: '/' }).catch(() => {});
    expect(announced).toEqual(['r1']);
  });
});

describe('the channel', () => {
  let root: string;
  let client: Client;
  let channel: ReturnType<typeof createChannel>;
  const opened: string[] = [];
  const pushed: { content: string; meta: Record<string, string> }[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  const requestId = (text: string) => /illuminate request (r\d+)/.exec(text)?.[1] ?? '';

  beforeAll(async () => {
    root = copyCareApp();
    channel = createChannel({ root, port: 0, open: (u) => opened.push(u), waitMs: 5000,
      heartbeatMs: 20,
      // No browser in tests: a stand-in that "sees" the convert button.
      shoot: async (url) => ({ png: Buffer.from(`shot of ${url}`), title: 'Patients', text: 'Patients Mark as converted', elements: [{ tag: 'button', text: 'Mark as converted', x: 640, y: 400, w: 128, h: 40 }] }),
    });
    client = new Client({ name: 'claude-code-stand-in', version: '0' });
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/claude/channel') pushed.push(n.params as (typeof pushed)[number]);
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([channel.mcp.connect(b), client.connect(a)]);
  });
  afterAll(async () => {
    await client.close();
    await channel.close();
    cleanup();
  });

  it('tells Claude Code it is a channel with tools, and how to use them', async () => {
    expect(client.getServerCapabilities()?.experimental).toHaveProperty('claude/channel');
    expect(client.getInstructions()).toContain('illuminate_submit');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['illuminate_map', 'illuminate_next', 'illuminate_submit', 'illuminate_fail', 'illuminate_listen', 'illuminate_screens', 'illuminate_capture', 'illuminate_open']);
  });

  let mapUrl = '';
  it('makes a map in one turn: the first request comes back from illuminate_map, the result from illuminate_submit', async () => {
    const first = await call('illuminate_map', { question: 'What happens when a patient converts?' });
    expect(first.isError).toBe(false);
    expect(opened).toHaveLength(1);
    mapUrl = opened[0]!;
    expect(first.text).toContain(mapUrl);
    expect(first.text).toContain('Making the map for "What happens when a patient converts?"');
    expect(first.text).toContain('## Output schema');
    const id = requestId(first.text);

    const wrong = await call('illuminate_submit', { request_id: id, output: { version: 1 } });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('Fix these');

    const done = await call('illuminate_submit', { request_id: id, output: CARE_MAP });
    expect(done.text).toContain('15 of 15 claims confirmed');
    expect(done.text).toContain(mapUrl.split('?')[0]);
    expect(done.text).toContain('call illuminate_listen');
    expect(pushed).toEqual([]);
  });

  const ask = async (question: string) => {
    const url = new URL(mapUrl);
    const mapId = url.pathname.split('/').pop()!;
    const res = await fetch(`${url.origin}/api/maps/${mapId}/ask`, {
      method: 'POST',
      headers: { 'x-illuminate-token': url.searchParams.get('t')!, 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    expect(res.status).toBe(202);
    return { url, mapId };
  };

  it('hands a question asked on the map to the listening call, keeping it alive meanwhile, and the answer goes back', async () => {
    const progress: number[] = [];
    const listening = client.callTool({ name: 'illuminate_listen', arguments: {} }, undefined, {
      onprogress: (p) => progress.push(p.progress),
      timeout: 10_000,
    }) as Promise<{ content: { text: string }[] }>;
    await waitFor(() => progress.length >= 2);
    const { url, mapId } = await ask('Where does the welcome email start?');
    const req = (await listening).content.map((c) => c.text).join('\n');
    expect(req).toContain('Answering "Where does the welcome email start?" from the map');
    expect(req).toContain('call illuminate_listen again');
    expect(pushed).toEqual([]);

    const done = await call('illuminate_submit', {
      request_id: requestId(req),
      output: { route: 'answer', concept: 'It starts when a patient converts.', refs: [] },
    });
    expect(done.text).toContain('is shown on the map. Call illuminate_listen again');
    const saved = await (await fetch(`${url.origin}/api/maps/${mapId}`, { headers: { 'x-illuminate-token': url.searchParams.get('t')! } })).json() as { answers: { concept: string }[] };
    expect(saved.answers.at(-1)?.concept).toBe('It starts when a patient converts.');
  });

  it('mentions a newer version once, with the first map, the way the plugin updates', async () => {
    const own = createChannel({ root, port: 0, open: () => {}, waitMs: 200, via: 'plugin', checkUpdate: async () => ({ current: '0.4.0', latest: '0.5.0' }) });
    const c = new Client({ name: 'claude-code-stand-in', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([own.mcp.connect(b), c.connect(a)]);
    const textOf = (r: unknown) => (r as { content: { text: string }[] }).content.map((x) => x.text).join('\n');
    try {
      const first = textOf(await c.callTool({ name: 'illuminate_map', arguments: { question: 'What happens when a patient converts?' } }));
      expect(first).toContain('A newer illuminate is out (0.5.0; this is 0.4.0).');
      expect(first).toContain('claude plugin update illuminate@illuminate');
      const second = textOf(await c.callTool({ name: 'illuminate_map', arguments: { question: 'Where is the email sent?' } }));
      expect(second).not.toContain('A newer illuminate is out');
    } finally {
      await c.close();
      await own.close();
    }
  });

  it('returns from a quiet listening call before Claude Code drops it, and stops after enough quiet ones', async () => {
    const quietChannel = createChannel({ root, port: 0, open: () => {}, listenMs: 20, quietListens: 3 });
    const quietClient = new Client({ name: 'claude-code-stand-in', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([quietChannel.mcp.connect(b), quietClient.connect(a)]);
    const listen = async () => ((await quietClient.callTool({ name: 'illuminate_listen', arguments: {} })) as { content: { text: string }[] }).content[0]!.text;
    try {
      await quietClient.callTool({ name: 'illuminate_open', arguments: {} });
      expect(await listen()).toContain('Nothing was asked on the map yet. Call illuminate_listen again');
      expect(await listen()).toContain('Call illuminate_listen again');
      expect(await listen()).toContain('stopped listening');
      // Asked to listen again after that, it listens afresh.
      expect(await listen()).toContain('Call illuminate_listen again');
    } finally {
      await quietClient.close();
      await quietChannel.close();
    }
  });

  it('ends listening when the person stops illuminate, and doesn\'t listen while it is closed', async () => {
    const own = createChannel({ root, port: 0, open: () => {} });
    const c = new Client({ name: 'claude-code-stand-in', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([own.mcp.connect(b), c.connect(a)]);
    const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
    try {
      expect(textOf(await c.callTool({ name: 'illuminate_listen', arguments: {} }))).toContain('closed illuminate');
      const opened = new URL(/Opened (\S+)/.exec(textOf(await c.callTool({ name: 'illuminate_open', arguments: {} })))![1]!);
      const listening = c.callTool({ name: 'illuminate_listen', arguments: {} });
      await new Promise((r) => setTimeout(r, 30));
      const res = await fetch(`${opened.origin}/api/stop`, { method: 'POST', headers: { 'x-illuminate-token': opened.searchParams.get('t')!, 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
      expect(textOf(await listening)).toContain('Don\'t call illuminate_listen again');
      expect(textOf(await c.callTool({ name: 'illuminate_listen', arguments: {} }))).toContain('closed illuminate');
    } finally {
      await c.close();
      await own.close();
    }
  });

  it('stops listening when Claude Code cancels the call', async () => {
    const ac = new AbortController();
    const listening = client.callTool({ name: 'illuminate_listen', arguments: {} }, undefined, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await expect(listening).rejects.toThrow();
    // Nothing is listening any more, so a question asked now is announced instead of vanishing into the cancelled call.
    await ask('Who sends the reminder?');
    await waitFor(() => pushed.length > 0);
    expect(pushed[0]!.content).toContain('Who sends the reminder?');
    const req = await call('illuminate_next');
    const done = await call('illuminate_submit', { request_id: requestId(req.text), output: { route: 'answer', concept: 'The nightly job.', refs: [] } });
    expect(done.text).toContain('is shown on the map');
    pushed.length = 0;
  });

  it('pushes a question asked on the map into a channel session when nothing is listening, and the answer goes back', async () => {
    const { url, mapId } = await ask('Why does no email go out?');
    await waitFor(() => pushed.length > 0);
    expect(pushed[0]).toMatchObject({ meta: { request_id: expect.stringMatching(/^r\d+$/) } });
    expect(pushed[0]!.content).toContain('Answering "Why does no email go out?" from the map');

    const req = await call('illuminate_next');
    expect(req.text).toContain('Answer from what is in this request alone');
    const done = await call('illuminate_submit', {
      request_id: requestId(req.text),
      output: { route: 'answer', concept: 'Nothing listens for the announcement, so the rules never run.', refs: ['miss'] },
    });
    expect(done.text).toContain('is shown on the map');

    const saved = await (await fetch(`${url.origin}/api/maps/${mapId}`, { headers: { 'x-illuminate-token': url.searchParams.get('t')! } })).json() as { answers: { concept: string }[] };
    expect(saved.answers.at(-1)?.concept).toContain('Nothing listens');
  });

  it('lists what the repo can show, captures a page for Claude to look at, and serves the checked screen to the map', async () => {
    writeFileSync(join(root, 'demo.html'), '<button>Mark as converted</button>');
    expect((await call('illuminate_screens')).text).toContain('  - demo.html');
    expect((await call('illuminate_capture', { url: 'https://example.com/' })).text).toContain('Only pages served on this machine');
    expect((await call('illuminate_capture', { file: '.env' })).isError).toBe(true);

    const r = (await client.callTool({ name: 'illuminate_capture', arguments: { file: 'demo.html' } })) as { content: { type: string; text?: string; data?: string; mimeType?: string }[] };
    const id = /Captured as (scr-[0-9a-f]+)/.exec(r.content[0]!.text!)?.[1] ?? '';
    expect(id).not.toBe('');
    expect(r.content[0]!.text).toContain('button "Mark as converted"');
    expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(r.content[1]!.data!, 'base64').toString()).toContain('shot of file://');

    // The box whose code says "Mark as converted" may carry it; the checker works out where the button is.
    const map = structuredClone(CARE_MAP);
    map.nodes[0].screen = { kind: 'capture', capture: id, highlight: 'Mark as converted' };
    expect(check(parseMapOrThrow(map), root).screens[map.nodes[0].id]).toMatchObject({ status: 'confirmed', show: { kind: 'capture', from: 'demo.html', box: { x: 0.5, y: 0.5 } } });

    const url = new URL(mapUrl);
    const t = url.searchParams.get('t')!;
    const img = await fetch(`${url.origin}/api/screens/${id}.png?t=${t}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${url.origin}/api/screens/${id}.png`)).status).toBe(401);
    expect((await fetch(`${url.origin}/api/screens/scr-nope.png?t=${t}`)).status).toBe(404);
    expect((await fetch(`${url.origin}/api/repo-image?file=.env&t=${t}`)).status).toBe(404);
    // The token in the URL opens pictures only, nothing else.
    expect((await fetch(`${url.origin}/api/maps?t=${t}`)).status).toBe(401);
  });

  it('opens saved maps and lists them', async () => {
    const r = await call('illuminate_open');
    expect(r.text).toContain('patient-converts  What happens when a patient converts?');
    expect(await call('illuminate_next')).toMatchObject({ text: 'Nothing is waiting right now.' });
  });
});

describe('the channel in Codex', () => {
  let root: string;
  let client: Client;
  let channel: ReturnType<typeof createChannel>;
  const opened: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  const requestId = (text: string) => /illuminate request (r\d+)/.exec(text)?.[1] ?? '';
  let mapUrl = '';

  beforeAll(async () => {
    root = copyCareApp();
    // Parts kept small, so the map's request comes in several.
    channel = createChannel({ root: '/', port: 0, open: (u) => opened.push(u), partChars: 6000, checkUpdate: async () => null });
    client = new Client({ name: CODEX_CLIENT, version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([channel.mcp.connect(b), client.connect(a)]);
  });
  afterAll(async () => {
    await client.close();
    await channel.close();
    cleanup();
  });

  it('gives Codex its tools: no listening, asking from the chat, nothing that needs approval', async () => {
    expect(client.getInstructions()).toContain('In Codex');
    expect(client.getInstructions()).toContain('illuminate_ask');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['illuminate_map', 'illuminate_next', 'illuminate_submit', 'illuminate_fail', 'illuminate_ask', 'illuminate_more', 'illuminate_screens', 'illuminate_capture', 'illuminate_open']);
    for (const t of tools) expect(t.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toEqual(['illuminate_next', 'illuminate_more', 'illuminate_screens']);
    // Every call returns well inside Codex's tool timeout.
    expect(CODEX.waitMs).toBeLessThanOrEqual(45_000);
  });

  it('makes a map without opening a browser, its request in parts, and says to open the link beside the chat', async () => {
    const first = await call('illuminate_map', { question: 'What happens when a patient converts?', repo: root });
    expect(opened).toEqual([]);
    mapUrl = /Give the person this link: (\S+)/.exec(first.text)?.[1] ?? '';
    expect(mapUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/m\/patient-converts\?t=/);
    expect(first.text).toContain('built-in browser');
    const id = requestId(first.text);
    const total = Number(/part 1 of (\d+)/.exec(first.text)?.[1]);
    expect(total).toBeGreaterThan(1);
    const pages = [first.text];
    for (let i = 2; i <= total; i++) pages.push((await call('illuminate_more', { request_id: id })).text);
    expect(pages.at(-1)).toContain('This is the last part.');
    expect(pages.join('\n')).toContain('## Output schema');
    expect(pages.at(-1)!.trimEnd().endsWith('}')).toBe(true);
    for (const p of pages.slice(1)) expect(p.length).toBeLessThan(6200);
    expect((await call('illuminate_more', { request_id: id, part: total + 1 })).isError).toBe(true);

    const done = await call('illuminate_submit', { request_id: id, output: CARE_MAP });
    expect(done.text).toContain('15 of 15 claims confirmed');
    expect(done.text).toContain('illuminate_ask');
    expect(done.text).not.toContain('illuminate_listen');
    const url = new URL(mapUrl);
    const page = await (await fetch(`${url.origin}/api/maps/patient-converts`, { headers: { 'x-illuminate-token': url.searchParams.get('t')! } })).json() as { agent: unknown };
    expect(page.agent).toEqual({ name: 'Codex', asks: 'chat' });
  });

  it('answers a question asked in the Codex chat about what is selected on the page, in the same turn', async () => {
    const url = new URL(mapUrl);
    const res = await fetch(`${url.origin}/api/maps/patient-converts/selection`, {
      method: 'PUT',
      headers: { 'x-illuminate-token': url.searchParams.get('t')!, 'content-type': 'application/json' },
      body: JSON.stringify({ selection: { nodes: ['s4'] } }),
    });
    expect(res.status).toBe(200);
    // No URL given: the map whose page reported last.
    const req = await call('illuminate_ask', { question: 'Why does no email go out?' });
    expect(req.text).toContain('Asked on the map "patient-converts" about');
    expect(req.text).toContain('Answering "Why does no email go out?" from the map');
    const done = await call('illuminate_submit', {
      request_id: requestId(req.text),
      output: {
        route: 'answer', concept: 'Nothing listens for the announcement.', refs: ['miss'],
        notes: [{ file: 'src/patients/service.ts', line: 6, text: "bus.emit('patient.converted'", note: 'The announcement goes out here.' }],
      },
    });
    // The checked answer comes back for Codex to post in its chat, with the line its note points at, read now.
    expect(done.text).toContain('Post the reply between the lines');
    expect(done.text).toContain('Nothing listens for the announcement.');
    expect(done.text).toContain('`src/patients/service.ts` · markConverted');
    expect(done.text).toContain("```ts\n");
    expect(done.text).toContain("6    bus.emit('patient.converted', { patientId });");
    expect(done.text).toContain('- Line 6: The announcement goes out here.');
    expect(done.text).not.toContain('illuminate_listen');
    const saved = await (await fetch(`${url.origin}/api/maps/patient-converts`, { headers: { 'x-illuminate-token': url.searchParams.get('t')! } })).json() as { answers: { concept: string; selection: unknown }[] };
    expect(saved.answers.at(-1)).toMatchObject({ concept: 'Nothing listens for the announcement.', selection: { nodes: ['s4'] } });

    // With the page's URL, the map it names.
    const again = await call('illuminate_ask', { question: 'And who sends the reminder?', url: mapUrl });
    expect(again.text).toContain('Asked on the map "patient-converts"');
    await call('illuminate_fail', { request_id: requestId(again.text), reason: 'test' });
  });

  it('never listens, and says when nothing is waiting', async () => {
    expect((await call('illuminate_listen')).isError).toBe(true);
    // The question given up on above goes on to the code; giving that up too ends it.
    const next = await call('illuminate_next');
    expect(next.text).toContain('from the code');
    await call('illuminate_fail', { request_id: requestId(next.text), reason: 'test' });
    await waitFor(async () => (await call('illuminate_next')).text === 'Nothing is waiting right now.');
  });

  it('tells the person to carry on in the chat when work started on the page has nobody to pick it up', async () => {
    const said: string[] = [];
    const bridge = createBridge({ announce: () => {}, host: () => CODEX, nudgeMs: 10 });
    void bridge.agent({ prompt: 'x', schema: MAP_SCHEMA, cwd: '/', onProgress: (p) => said.push(p.text) }).catch(() => {});
    await waitFor(() => said.length === 2);
    expect(said).toEqual([CODEX.waiting, CODEX.notPickedUp]);
    expect(said[1]).toContain('carry on with illuminate');
    bridge.fail('r1', 'done');
  });
});

describe('cutting a request into parts', () => {
  it('cuts at line ends, and cuts a line only when it is longer than a part', () => {
    const t = ['a'.repeat(5), 'b'.repeat(5), 'c'.repeat(12), 'd'].join('\n');
    const parts = partsOf(t, 11);
    expect(parts).toEqual(['aaaaa\nbbbbb', 'ccccccccccc', 'c\nd']);
    expect(parts.every((p) => p.length <= 11)).toBe(true);
    expect(partsOf('short', 100)).toEqual(['short']);
  });
});
