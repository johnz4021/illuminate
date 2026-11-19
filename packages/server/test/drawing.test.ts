// When an answer grows the map: decided by what the answer is (a path, a box's insides, a branch, a connection), not by
// the words in the question, in both answering steps. Whether Claude follows it is checked with real questions, not here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { check, parseMap } from '@illuminate/core';
import { explainerPrompt, quickAnswerPrompt } from '../src/prompts';
import { cleanup, copyCareApp } from './helpers';

afterAll(cleanup);

const map = (() => {
  const r = parseMap(JSON.parse(readFileSync(fileURLToPath(new URL('../../core/test/fixtures/care-app.map.json', import.meta.url)), 'utf8')));
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.map;
})();
const report = check(map, copyCareApp());

describe('drawing an answer or saying it', () => {
  it('lets the answer from the map alone hand on any answer that should be drawn, since only the next step can draw', () => {
    const p = quickAnswerPrompt(map, report, [], 'what happens inside this?', '', []);
    expect(p).toContain('Decide by what the answer is, not by the words in the question');
    expect(p).toContain('the answer is said, not drawn');
    expect(p).toContain('or the answer is one to draw (above), which only the next step can do');
  });

  it('tells the step that explores to draw such answers, connected where they belong, and to say facts', () => {
    const p = explainerPrompt(map, report, [], 'what happens inside this?');
    expect(p).toContain('what happens inside a box, the steps it hides');
    expect(p).toContain('even if you could also say it in words');
    expect(p).toContain("What's inside a box goes right after it");
    expect(p).toContain('When the answer is a fact to say');
  });
});
