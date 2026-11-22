// Someone new to a codebase asked "where does creating an account happen" and got only one of its two ways: the
// offer of a new map had rewritten the question to name one route, and nothing told the maker to show every way in.
// Whether Claude follows these is checked with real maps, not here.
import { describe, expect, it } from 'vitest';
import { makerPrompt, quickAnswerPrompt } from '../src/prompts';
import type { CodeMap, CheckReport } from '@illuminate/core';

describe('more than one way in', () => {
  it('tells the maker to draw each way something can happen', () => {
    const p = makerPrompt('Where does creating an account happen?', '');
    expect(p).toContain('can happen more than one way');
    expect(p).toContain('draw each way to where they meet');
  });

  it('gives a wrapper its own box that says what it fills in', () => {
    const p = makerPrompt('Where does creating an account happen?', '');
    expect(p).toContain('A wrapper is not just handing on');
    expect(p).toContain('is its own box, cited in the wrapper itself');
    expect(p).toContain('says what it fills in and how');
  });

  it('keeps the question for a new map in their own words, without narrowing it', () => {
    const map = { version: 1, question: 'q', areas: [], nodes: [], edges: [], absences: [], tour: [] } as unknown as CodeMap;
    const report = { nodes: {}, edges: {}, absences: {} } as unknown as CheckReport;
    const p = quickAnswerPrompt(map, report, [], 'Where does creating an account happen?', '', []);
    expect(p).toContain('their question in their own words');
    expect(p).toContain('Don\'t add a route, function or detail they didn\'t ask about');
  });
});
