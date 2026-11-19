// What a map's page reports about itself (what is selected, which map is open), and a question asked in the agent's
// chat that leans on it. Memory only; a scripted Claude answers.
import * as net from 'node:net';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askAboutStep as pageStep } from '../../viewer/src/step';
import { startServer, type IlluminateServer, type ServerEvent } from '../src/server';
import { askAboutStep } from '../src/step';
import { CARE_MAP, cleanup, copyCareApp, scriptedAgent, waitFor } from './helpers';

let server: IlluminateServer;
const events: ServerEvent[] = [];
const agent = scriptedAgent([
  () => CARE_MAP,
  () => ({ route: 'answer', concept: 'It tells the rest of the app the patient converted.', refs: ['s4'] }),
  () => ({ route: 'answer', concept: 'This step is where the welcome email should start.', refs: [] }),
]);

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'x-illuminate-token': server.token, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const done = (n: number) => waitFor(() => events.filter((e) => e.type === 'job' && e.status === 'done').length >= n);

beforeAll(async () => {
  server = await startServer({ root: copyCareApp(), port: 0, agent, viewerDir: join('/', 'no-viewer'), page: { name: 'Codex', asks: 'chat' }, onEvent: (e) => events.push(e) });
  server.startMap('What happens when a patient converts?');
  await done(1);
});
afterAll(async () => {
  await server.close();
  cleanup();
});

describe('a map page reporting what is selected', () => {
  it('tells the page who does the work and where questions are asked', async () => {
    expect((await api('GET', '/api/maps/patient-converts')).body.agent).toEqual({ name: 'Codex', asks: 'chat' });
    expect((await api('GET', '/api/maps')).body.agent).toEqual({ name: 'Codex', asks: 'chat' });
  });

  it('tells the page who asks while the map is still being made, so the right question box shows from the start', async () => {
    const making = await startServer({ root: copyCareApp(), port: 0, agent: () => new Promise(() => {}), viewerDir: '/no-viewer', page: { name: 'Codex', asks: 'chat' } });
    try {
      const id = making.startMap('Where does the email go?');
      const res = await fetch(`${making.url}/api/maps/${id}`, { headers: { 'x-illuminate-token': making.token } });
      const body = (await res.json()) as { map: unknown; job: unknown; agent: unknown };
      expect(body.map).toBeNull();
      expect(body.job).not.toBeNull();
      expect(body.agent).toEqual({ name: 'Codex', asks: 'chat' });
    } finally {
      await making.close();
    }
  });

  it('knows which map was open last: the one a page connected to', async () => {
    expect(server.lastSeen()).toBeNull();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?t=${server.token}&m=patient-converts`);
    await new Promise((r) => ws.once('open', r));
    expect(server.lastSeen()?.mapId).toBe('patient-converts');
    ws.close();
  });

  it('keeps the selection, only with the token and for a map that exists', async () => {
    expect((await api('PUT', '/api/maps/patient-converts/selection', { selection: { nodes: ['s4'] } }, { 'x-illuminate-token': 'nope' })).status).toBe(401);
    expect((await api('PUT', '/api/maps/patient-converts/selection', { selection: { nodes: ['s4'] } }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await api('PUT', '/api/maps/no-such-map/selection', { selection: {} })).status).toBe(404);
    expect((await api('PUT', '/api/maps/patient-converts/selection', { selection: { nodes: ['s4', 7] } })).body).toEqual({ ok: true });
  });

  it('answers a question asked in the chat about what is selected on the page', async () => {
    const asked = server.askFromChat('What does this do?');
    expect(asked).toMatchObject({ mapId: 'patient-converts', question: 'What does this do?' });
    expect(asked.selected).toHaveLength(1);
    await done(2);
    const call = agent.calls[1]!;
    expect(call.prompt).toContain('What does this do?');
    expect(call.prompt).toContain(`box "${asked.selected[0]}"`);
    const saved = (await api('GET', '/api/maps/patient-converts')).body;
    expect(saved.answers.at(-1)).toMatchObject({ question: 'What does this do?', selection: { nodes: ['s4'] } });
    // Who is working is named on the page's progress and errors.
    expect(events.filter((e) => e.type === 'progress').map((e) => (e as { text: string }).text)).toContain('Codex is exploring the code');
  });

  it('asks about the walkthrough stop on screen when nothing is selected, worded the way the page words it', async () => {
    expect(askAboutStep('The announcement', 'Why?')).toBe(pageStep('The announcement', 'Why?'));
    await api('PUT', '/api/maps/patient-converts/selection', { selection: {}, step: 'The announcement' });
    const asked = server.askFromChat('Why is this here?', 'patient-converts');
    expect(asked.question).toBe(askAboutStep('The announcement', 'Why is this here?'));
    await done(3);
  });

  it('says so when there is no such map', () => {
    expect(() => server.askFromChat('Why?', 'no-such-map')).toThrow('There is no map "no-such-map"');
  });
});

describe('the page server\'s port', () => {
  it('moves to the next port when the one it wants is taken, so the address stays close to the usual one', async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', () => r()));
    const port = (taken.address() as net.AddressInfo).port;
    const s = await startServer({ root: copyCareApp(), port, agent: scriptedAgent([]), viewerDir: '/no-viewer' });
    try {
      expect(s.port).not.toBe(port);
      expect(s.port).toBeGreaterThan(port);
      expect(s.port).toBeLessThanOrEqual(port + 10);
    } finally {
      await s.close();
      taken.close();
    }
  });
});
