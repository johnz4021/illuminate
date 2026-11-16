// The head start Claude gets before exploring: the app's ways in, not its tests', and no cut-off function list.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { headStart } from '../src/hints';
import { cleanup, copyCareApp } from './helpers';

afterAll(cleanup);

describe('headStart', () => {
  it('leaves tests and fixtures out of every section', async () => {
    const root = copyCareApp();
    mkdirSync(join(root, 'test/fixtures/copy'), { recursive: true });
    cpSync(join(root, 'src/server/routes.ts'), join(root, 'test/fixtures/copy/routes.ts'));
    const { text } = await headStart(root);
    expect(text).toContain('src/server/routes.ts#convertPatient');
    expect(text).not.toContain('test/fixtures');
  });

  it('lists function names in a small repo, and says why it does not in a big one', async () => {
    const root = copyCareApp();
    expect((await headStart(root)).text).toContain('Functions by file (use these exact names');
    mkdirSync(join(root, 'src/many'), { recursive: true });
    for (let i = 0; i < 160; i++) writeFileSync(join(root, `src/many/f${i}.ts`), `export function f${i}() { return ${i}; }\n`);
    const { text } = await headStart(root);
    expect(text).toContain('Functions by file: not listed');
    expect(text).not.toContain('src/many/f1.ts');
    expect(text).toContain('src/server/routes.ts#convertPatient');
  });
});
