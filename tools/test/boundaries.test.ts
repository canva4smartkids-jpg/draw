import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkBoundaries, findCycles, importsOf } from '../boundaries.ts';
import type { LayerRule } from '../boundaries.ts';

let root = '';
const write = (path: string, text: string): void => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};
const pkg = (name: string, deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): string =>
  JSON.stringify({ name: `@draw/${name}`, dependencies: deps, devDependencies: devDeps });

const LAYERS: Record<string, LayerRule> = {
  geometry: { allow: [], platform: 'neutral' },
  document: { allow: ['geometry'], platform: 'neutral' },
  testkit: { allow: ['*'], platform: 'node' },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boundaries-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('importsOf finds static, re-export and dynamic imports but not comments or strings', () => {
  const src = [
    "import { a } from './a.ts';",
    "export * from '@draw/geometry';",
    "// import nope from 'commented';",
    'const s = "import x from \'in-a-string\'";',
    "const m = await import('node:fs');",
  ].join('\n');
  assert.deepEqual(
    importsOf(src).map((i) => [i.specifier, i.line]),
    [
      ['./a.ts', 1],
      ['@draw/geometry', 2],
      ['node:fs', 5],
    ],
  );
});

test('a clean layered repo passes', () => {
  write('packages/geometry/package.json', pkg('geometry'));
  write('packages/geometry/src/index.ts', "export * from './vec.ts';\n");
  write('packages/geometry/src/vec.ts', 'export const x = 1;\n');
  write('packages/document/package.json', pkg('document', { '@draw/geometry': '0.0.0' }, { '@draw/testkit': '0.0.0' }));
  write('packages/document/src/index.ts', "import { x } from '@draw/geometry';\nexport const y = x;\n");
  write(
    'packages/document/test/a.test.ts',
    "import { y } from '@draw/document';\nimport 'node:fs';\nimport '@draw/testkit';\nvoid y;\n",
  );
  write('packages/testkit/package.json', pkg('testkit'));
  write('packages/testkit/src/index.ts', "import 'node:zlib';\n");
  assert.deepEqual(checkBoundaries(root, LAYERS), []);
});

test('reports upward imports, undeclared deps, Node built-ins, escaping relatives and unknown packages', () => {
  write('packages/geometry/package.json', pkg('geometry'));
  write(
    'packages/geometry/src/index.ts',
    [
      "import '@draw/document';", // upward
      "import 'node:fs';", // neutral package
      "import '../../document/src/index.ts';", // escapes package
      "import 'left-pad';", // undeclared third party
      "import '@draw/geometry';", // self by name from src
    ].join('\n'),
  );
  write('packages/document/package.json', pkg('document'));
  write('packages/document/src/index.ts', "import '@draw/geometry';\n"); // allowed layer, not declared
  write('packages/mystery/package.json', pkg('mystery'));
  const messages = checkBoundaries(root, LAYERS).map((v) => `${v.file}:${v.line}: ${v.message}`);
  assert.deepEqual(messages, [
    'packages/document/src/index.ts:1: "@draw/geometry" is imported but not listed in document\'s dependencies',
    'packages/geometry/src/index.ts:1: geometry may not depend on document (allowed: none)',
    'packages/geometry/src/index.ts:2: "node:fs": geometry is platform-neutral and may not import Node built-ins',
    'packages/geometry/src/index.ts:3: relative import "../../document/src/index.ts" escapes package geometry; import it by package name',
    'packages/geometry/src/index.ts:4: third-party "left-pad" is not declared in geometry\'s package.json',
    'packages/geometry/src/index.ts:5: "@draw/geometry": a package must import its own modules relatively',
    'packages/mystery/package.json:1: package "mystery" is not in the layer table (tools/boundaries.ts)',
  ]);
});

test("'electron' is only allowed in the desktop main and preload code", () => {
  write('apps/desktop/src/main/app.ts', "import { app } from 'electron';\nvoid app;\n");
  write('apps/desktop/src/preload/index.ts', "import { contextBridge } from 'electron';\nvoid contextBridge;\n");
  write('apps/desktop/src/renderer/ui.ts', "import { ipcRenderer } from 'electron';\nvoid ipcRenderer;\n");
  assert.deepEqual(
    checkBoundaries(root, LAYERS).map((v) => v.file),
    ['apps/desktop/src/renderer/ui.ts'],
  );
});

test('the layer table itself must be acyclic', () => {
  assert.deepEqual(findCycles(LAYERS), []);
  assert.deepEqual(findCycles({ a: { allow: ['b'], platform: 'neutral' }, b: { allow: ['a'], platform: 'neutral' } }), [
    'a -> b -> a',
  ]);
});
