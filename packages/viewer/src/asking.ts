// Where a question about the map is asked. With Claude Code (and the CLI) it is the map's own question box. In Codex
// the person asks in the Codex chat beside this page, so the box says so, and the page tells illuminate what is
// selected (and the walkthrough stop on screen) for the question to be about.
import type { Sel } from './state';
import type { PageAgent } from './types';

export const DEFAULT_AGENT: PageAgent = { name: 'Claude', asks: 'page' };

export const asksInChat = (agent: PageAgent): boolean => agent.asks === 'chat';

/** What the question box says in place of taking a question, when questions are asked in the agent's chat. */
export function chatHint(agent: PageAgent, selected: number, step: string | null): { title: string; detail: string } {
  return {
    title: `Ask in the ${agent.name} chat beside this page`,
    detail: selected
      ? `${agent.name} will see what you selected here.`
      : step
        ? `${agent.name} will know you're on the step “${step}”.`
        : `${agent.name} will see what you select here.`,
  };
}

/** What the page tells illuminate about itself, or null when there's no need (questions are typed on the page). */
export function selectionReport(agent: PageAgent, selection: Sel, step: string | null): { selection: Sel; step: string | null } | null {
  return asksInChat(agent) ? { selection, step } : null;
}
