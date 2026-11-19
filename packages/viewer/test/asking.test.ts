// Where questions are asked: in the map's own box, or (Codex) in the agent's chat beside the page.
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT, asksInChat, chatHint, selectionReport } from '../src/asking';
import { emptySel } from '../src/state';

const codex = { name: 'Codex', asks: 'chat' as const };

describe('asking about the map', () => {
  it('takes questions on the page unless the agent asks in its chat', () => {
    expect(asksInChat(DEFAULT_AGENT)).toBe(false);
    expect(asksInChat(codex)).toBe(true);
  });

  it('points to the chat, and says what the agent will see', () => {
    expect(chatHint(codex, 0, null)).toEqual({ title: 'Ask in the Codex chat beside this page', detail: 'Codex will see what you select here.' });
    expect(chatHint(codex, 2, null).detail).toBe('Codex will see what you selected here.');
    expect(chatHint(codex, 0, 'The announcement').detail).toBe('Codex will know you\'re on the step “The announcement”.');
  });

  it('reports the selection only when questions are asked in the chat', () => {
    const sel = { ...emptySel(), nodes: ['s4'] };
    expect(selectionReport(DEFAULT_AGENT, sel, null)).toBeNull();
    expect(selectionReport(codex, sel, 'Step')).toEqual({ selection: sel, step: 'Step' });
  });
});
