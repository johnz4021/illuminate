// Ways through (`branch`) are for every kind of map, not only journeys: two ways in, or the options of a change to
// compare. Whether Claude uses them well is checked with real maps, not here.
import { describe, expect, it } from 'vitest';
import { makerPrompt } from '../src/prompts';

describe('ways through', () => {
  const p = makerPrompt('How would (a) or (b) change what people see?', '');

  it('are a shared rule, before the sections for particular kinds of map', () => {
    expect(p).toContain('## Ways through (`branch`, on any kind of map)');
    expect(p.indexOf('## Ways through')).toBeLessThan(p.indexOf('## When the answer is parties taking turns'));
    expect(p.indexOf('## Ways through')).toBeLessThan(p.indexOf('## When the question is about what a person sees'));
  });

  it('carry the options of a change to compare, each drawn to where its effect shows', () => {
    expect(p).toContain('each option is a way through (see Ways through) named for it');
    expect(p).toContain('drawn as far as where its effect shows');
  });

  it('leave journeys only how their branches are laid out', () => {
    expect(p).toContain('One main path, with branches (see Ways through)');
  });
});
