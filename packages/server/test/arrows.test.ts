// Arrow labels are read as a sentence starting from the box the arrow leaves, so a label that only says what the next
// box does gets pinned on the wrong actor ("Bob locks funds → claims with secret → Alice claims" reads as Bob
// claiming). Whether Claude follows it is checked with real maps, not here.
import { describe, expect, it } from 'vitest';
import { makerPrompt } from '../src/prompts';

describe('arrow labels', () => {
  it('tells Claude a label reads from the box it leaves, and to say who does the next step', () => {
    const p = makerPrompt('How does a swap across two chains work?', '');
    expect(p).toContain('"<from box> <label> <to box>"');
    expect(p).toContain('When someone else does the next step, say who or what sets it off');
  });
});
