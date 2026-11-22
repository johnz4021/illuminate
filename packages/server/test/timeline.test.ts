// A timeline is Claude's call, like a journey: for parties that take turns, where the order between them is the
// point. Whether Claude picks it for the right questions is checked with real maps, not here.
import { describe, expect, it } from 'vitest';
import { makerPrompt } from '../src/prompts';
import { MAP_SCHEMA } from '../src/schemas';

describe('a timeline map', () => {
  it('tells Claude when to draw one, that each area is a lane, and when not to', () => {
    const p = makerPrompt('How does a swap across two chains work?', '');
    expect(p).toContain('Set `"view": "timeline"` when the answer is two or more parties or places handing off to each other');
    expect(p).toContain('make each area one party or place');
    expect(p).toContain('Not for a flow that passes through each place once');
  });

  it('lets Claude write it', () => {
    expect(JSON.stringify(MAP_SCHEMA)).toContain('"timeline"');
  });
});
