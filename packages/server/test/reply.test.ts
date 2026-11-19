// An answer as Codex posts it in its chat: the checked reply, the code its notes point at, and what the map has to act on.
import { afterAll, describe, expect, it } from 'vitest';
import type { Answer } from '../src/explainer';
import { chatReply } from '../src/reply';
import { cleanup, copyCareApp } from './helpers';

const root = copyCareApp();
afterAll(() => cleanup());

const answer = (over: Partial<Answer>): Answer => ({
  id: 'a1', question: 'q', selection: {}, concept: 'It announces the conversion.', refs: [], moves: { focus: null, highlight: [] },
  added: [], problems: [], fix: null, source: 'map', cost: 0, ...over,
});

describe('a reply for the chat', () => {
  it('is just the answer when it points at no code', () => {
    expect(chatReply(root, answer({}))).toBe('It announces the conversion.');
  });

  it('shows the lines a note points at, with a few around them, and the note under them', () => {
    const text = chatReply(root, answer({ notes: [{ file: 'src/patients/service.ts', line: 5, text: "await db.update('patients'", note: 'Saved as enrolled.' }] }));
    expect(text).toContain('`src/patients/service.ts` · markConverted (lines 4–7)');
    expect(text).toContain("5    await db.update('patients'");
    expect(text).toContain('- Line 5: Saved as enrolled.');
  });

  it('says what is unconfirmed, what is gone, and that a fix waits on the map', () => {
    const text = chatReply(root, answer({
      refs: [{ id: 'miss', status: 'unconfirmed' }],
      notes: [{ file: 'src/patients/service.ts', line: 400, text: 'nowhere', note: 'Gone.' }],
      fix: { id: 'f1' } as Answer['fix'],
    }));
    expect(text).toContain('Not confirmed against the code: miss');
    expect(text).toContain("aren't in the code any more");
    expect(text).toContain('A fix is proposed on the map: approve or reject it there.');
  });
});
