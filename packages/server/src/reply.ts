// An answer as Codex posts it in its chat. In Codex the person asks in the chat beside the map, so the reply belongs
// there too, not in a column on the page. The answer still goes through illuminate first: its references and its notes
// on lines of code are checked, and the map lights up what it is about. What Codex gets back to post is the checked
// answer, with the code its notes point at read again now (`codeForNotes`), as Markdown code blocks with line numbers.
// Codex is told to post it unchanged; that is an instruction, not something illuminate can enforce.
import * as path from 'node:path';
import { codeForNotes, type CodeBlock } from '@illuminate/core';
import type { Answer } from './explainer';

/** Lines kept around the noted lines of a block, and the most lines one block shows in the chat. */
const AROUND = 3;
const MAX_LINES = 30;
const MAX_BLOCKS = 4;

const LANG: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js', '.py': 'python', '.go': 'go',
  '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.sol': 'solidity', '.css': 'css', '.html': 'html', '.json': 'json',
  '.sql': 'sql', '.sh': 'bash', '.yml': 'yaml', '.yaml': 'yaml', '.md': 'markdown',
};

/** The part of a block worth showing in a chat: the noted lines and a few around them, at most MAX_LINES. */
function excerpt(b: CodeBlock): { start: number; lines: string[] } {
  const marked = b.notes.length ? b.notes.map((n) => n.line) : b.cited;
  const end = b.start + b.lines.length - 1;
  let from = Math.max(b.start, Math.min(...marked) - AROUND);
  let to = Math.min(end, Math.max(...marked) + AROUND);
  if (to - from + 1 > MAX_LINES) to = from + MAX_LINES - 1;
  if (!marked.length) [from, to] = [b.start, Math.min(end, b.start + MAX_LINES - 1)];
  return { start: from, lines: b.lines.slice(from - b.start, to - b.start + 1) };
}

/** One block as Markdown: where it is, the lines with their numbers, then each note under the line it's about. */
function blockText(b: CodeBlock): string {
  const { start, lines } = excerpt(b);
  const width = String(start + lines.length - 1).length;
  const numbered = lines.map((l, i) => `${String(start + i).padStart(width)}  ${l}`).join('\n');
  const where = `\`${b.file}\`${b.name ? ` · ${b.name}` : ''} (lines ${start}–${start + lines.length - 1})`;
  const notes = b.notes.filter((n) => n.line >= start && n.line < start + lines.length).map((n) => `- Line ${n.line}: ${n.note}`);
  return [where, `\`\`\`${LANG[path.extname(b.file)] ?? ''}`, numbered, '```', ...notes].join('\n');
}

/** The checked answer, ready for the chat: the reply, the code its notes point at, and what the map has to act on. */
export function chatReply(root: string, a: Answer): string {
  const parts = [a.concept.trim()];
  const unconfirmed = a.refs.filter((r) => r.status === 'unconfirmed').map((r) => r.id);
  if (unconfirmed.length) parts.push(`_Not confirmed against the code: ${unconfirmed.join(', ')}._`);
  if (a.notes?.length) {
    const view = codeForNotes(root, a.notes);
    const blocks = view.blocks.slice(0, MAX_BLOCKS).map(blockText);
    if (blocks.length) parts.push(blocks.join('\n\n'));
    if (view.missing) parts.push(`_${view.missing} of the lines it points at aren't in the code any more, so they're left out._`);
  }
  if (a.fix) parts.push('A fix is proposed on the map: approve or reject it there.');
  return parts.join('\n\n');
}
