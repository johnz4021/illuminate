// Which coding agent is doing illuminate's model work through the channel, and what that changes. Claude Code and
// Codex both start `illume channel` as an MCP server, but they differ in ways the person notices:
// - Claude Code moves a tool call that runs past two minutes to the background and wakes the session when it returns,
//   so a listening call carries questions asked on the map into the session.
// - Codex has no background calls, drops custom notifications, and no MCP server can start a turn there, so questions
//   are asked in the Codex chat (beside the map, in the desktop app's built-in browser) and come in through
//   `illuminate_ask`. Its tool calls time out (60 s by default in its docs), so nothing waits longer than `waitMs`, and
//   tool output past about 10k tokens is cut, so long requests come in parts (`pageText` in channel.ts).
// Codex's MCP client names itself "codex-mcp-client" in the initialize request (openai/codex, `codex-rs`).
import type { PageAgent } from './server';

export type HostId = 'claude-code' | 'codex';

export type AgentHost = {
  id: HostId;
  /** The agent's name, as the person knows it. */
  name: string;
  /** What the map page is told: who is working, and where questions are asked. */
  page: PageAgent;
  /** Progress on the map once the agent has picked a request up. */
  claimed: string;
  /** Progress on the map while a request waits for the agent. */
  waiting: string;
  /** Said on the map when a request has waited `nudgeMs` with nobody picking it up. */
  notPickedUp: string;
  /** The error once nobody picked a request up at all. */
  neverPickedUp: string;
  /** How long a request waits unclaimed before the map says `notPickedUp`. */
  nudgeMs: number;
  /** How long a tool call waits for what comes next before handing the turn back. */
  waitMs: number;
};

export const CODEX_CLIENT = 'codex-mcp-client';

export const CLAUDE_CODE: AgentHost = {
  id: 'claude-code',
  name: 'Claude Code',
  page: { name: 'Claude', asks: 'page' },
  claimed: 'Claude Code is working on this in your terminal',
  waiting: 'Waiting for Claude Code to pick this up',
  notPickedUp: 'Claude Code isn\'t listening to the map right now. In your Claude Code session, say "listen to illuminate", and it will pick this up.',
  neverPickedUp: 'Claude Code never picked this up, so nothing was answered. Its session may have closed. In Claude Code, say "listen to illuminate", then ask again.',
  nudgeMs: 30_000,
  waitMs: 90_000,
};

export const CODEX: AgentHost = {
  id: 'codex',
  name: 'Codex',
  page: { name: 'Codex', asks: 'chat' },
  claimed: 'Codex is working on this in the Codex chat',
  waiting: 'Waiting for Codex to pick this up',
  // Codex can't be woken from the page, so this is said as soon as it's clear nobody has it.
  notPickedUp: 'Codex can\'t see work started on this page. In the Codex chat, say "carry on with illuminate", and it will pick this up.',
  neverPickedUp: 'Codex never picked this up, so nothing was answered. Ask in the Codex chat instead.',
  nudgeMs: 1_500,
  // Codex's documented default tool timeout is 60 s; progress doesn't extend it.
  waitMs: 40_000,
};

/** The agent behind an MCP client, from the client info it sent when it connected. */
export function hostOf(client: { name?: string } | undefined): AgentHost {
  return client?.name === CODEX_CLIENT ? CODEX : CLAUDE_CODE;
}
