// Architecture boundary rules (docs/architecture/proposal.md §3.2) and the
// checker that enforces them. Run with `npm run boundaries`.
//
// Rules, for every source file:
//  - a package may import only the @draw packages its layer allows, and only
//    if they are declared in its package.json;
//  - platform-neutral packages (everything except testkit) may not import
//    Node built-ins: they must run in the renderer, in workers and in Node;
//  - only the Electron main and preload code may import 'electron';
//  - relative imports may not escape their package;
//  - third-party imports must be declared dependencies.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve, dirname, sep } from 'node:path';
import ts from 'typescript';

export type Platform = 'neutral' | 'node';

export interface LayerRule {
  /** @draw packages this package's src/ may import ('*' = any) */
  readonly allow: readonly string[];
  readonly platform: Platform;
}

/** Layer table: lower layers never import higher ones. Planned packages are listed so the rules exist before the code. */
export const LAYERS: Readonly<Record<string, LayerRule>> = {
  geometry: { allow: [], platform: 'neutral' },
  color: { allow: [], platform: 'neutral' },
  archive: { allow: [], platform: 'neutral' },
  document: { allow: ['geometry', 'color'], platform: 'neutral' },
  'format-native': { allow: ['document', 'archive', 'geometry', 'color'], platform: 'neutral' },
  render: { allow: ['document', 'geometry', 'color'], platform: 'neutral' },
  editor: { allow: ['document', 'render', 'geometry', 'color'], platform: 'neutral' },
  'io-cdr': { allow: ['archive', 'document', 'geometry', 'color'], platform: 'neutral' },
  'io-svg': { allow: ['archive', 'document', 'geometry', 'color', 'render'], platform: 'neutral' },
  'io-pdf': { allow: ['archive', 'document', 'geometry', 'color', 'render'], platform: 'neutral' },
  'io-raster': { allow: ['document', 'geometry', 'color', 'render'], platform: 'neutral' },
  testkit: { allow: ['*'], platform: 'node' },
};

/** Directories (relative to the repo root, '/'-separated) where 'electron' may be imported. */
export const ELECTRON_ALLOWED = ['apps/desktop/src/main/', 'apps/desktop/src/preload/'];

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Module specifiers imported by a source file, with their line numbers. */
export function importsOf(source: string): { specifier: string; line: number }[] {
  const info = ts.preProcessFile(source, true, true);
  const lineOf = (pos: number): number => source.slice(0, pos).split('\n').length;
  return info.importedFiles.map((f) => ({ specifier: f.fileName, line: lineOf(f.pos) }));
}

const packageNameOf = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
};

/** Check every package under `root`/packages (and apps/desktop when present). */
export function checkBoundaries(root: string, layers: Readonly<Record<string, LayerRule>> = LAYERS): Violation[] {
  const violations: Violation[] = [];
  const rel = (p: string): string => relative(root, p).split(sep).join('/');
  const report = (file: string, line: number, message: string): void => {
    violations.push({ file: rel(file), line, message });
  };

  for (const cycle of findCycles(layers)) {
    violations.push({ file: 'tools/boundaries.ts', line: 1, message: `layer table has a cycle: ${cycle}` });
  }

  const packagesDir = join(root, 'packages');
  const packageDirs = existsSync(packagesDir)
    ? readdirSync(packagesDir).filter((d) => existsSync(join(packagesDir, d, 'package.json')))
    : [];

  for (const dirName of packageDirs) {
    const pkgDir = join(packagesDir, dirName);
    const pkg = readJson(join(pkgDir, 'package.json'));
    const rule = layers[dirName];
    if (!rule) {
      report(join(pkgDir, 'package.json'), 1, `package "${dirName}" is not in the layer table (tools/boundaries.ts)`);
      continue;
    }
    if (pkg.name !== `@draw/${dirName}`) {
      report(join(pkgDir, 'package.json'), 1, `package name must be "@draw/${dirName}", found "${String(pkg.name)}"`);
    }
    const deps = new Set(Object.keys(pkg.dependencies ?? {}));
    const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));

    for (const [kind, dir] of [
      ['src', join(pkgDir, 'src')],
      ['test', join(pkgDir, 'test')],
    ] as const) {
      for (const file of listTs(dir)) {
        for (const { specifier, line } of importsOf(readFileSync(file, 'utf8'))) {
          checkSpecifier({ file, line, specifier, kind, dirName, pkgDir, rule, deps, devDeps, report, rel });
        }
      }
    }
  }

  // Electron may only appear in the desktop main/preload code.
  const appsDir = join(root, 'apps');
  for (const file of listTs(appsDir)) {
    const path = rel(file);
    for (const { specifier, line } of importsOf(readFileSync(file, 'utf8'))) {
      if (packageNameOf(specifier) === 'electron' && !ELECTRON_ALLOWED.some((p) => path.startsWith(p))) {
        report(file, line, `'electron' may only be imported in ${ELECTRON_ALLOWED.join(' or ')}`);
      }
    }
  }
  return violations;
}

interface SpecifierContext {
  file: string;
  line: number;
  specifier: string;
  kind: 'src' | 'test';
  dirName: string;
  pkgDir: string;
  rule: LayerRule;
  deps: ReadonlySet<string>;
  devDeps: ReadonlySet<string>;
  report: (file: string, line: number, message: string) => void;
  rel: (p: string) => string;
}

function checkSpecifier(c: SpecifierContext): void {
  const { file, line, specifier, kind, dirName, pkgDir, rule, deps, devDeps, report } = c;

  if (specifier.startsWith('.')) {
    const target = resolve(dirname(file), specifier);
    if (!target.startsWith(pkgDir + sep)) {
      report(file, line, `relative import "${specifier}" escapes package ${dirName}; import it by package name`);
    }
    return;
  }
  if (NODE_BUILTINS.has(specifier)) {
    if (kind === 'src' && rule.platform === 'neutral') {
      report(file, line, `"${specifier}": ${dirName} is platform-neutral and may not import Node built-ins`);
    }
    return;
  }
  const name = packageNameOf(specifier);
  if (name === 'electron') {
    report(file, line, `'electron' may only be imported in ${ELECTRON_ALLOWED.join(' or ')}`);
    return;
  }
  if (name.startsWith('@draw/')) {
    const target = name.slice('@draw/'.length);
    if (target === dirName) {
      // Tests should go through the public entry point; sources must not.
      if (kind === 'src') report(file, line, `"${specifier}": a package must import its own modules relatively`);
      return;
    }
    if (kind === 'src') {
      if (!rule.allow.includes('*') && !rule.allow.includes(target)) {
        report(file, line, `${dirName} may not depend on ${target} (allowed: ${rule.allow.join(', ') || 'none'})`);
      } else if (!deps.has(name)) {
        report(file, line, `"${name}" is imported but not listed in ${dirName}'s dependencies`);
      }
    } else if (!deps.has(name) && !devDeps.has(name)) {
      report(file, line, `"${name}" is imported by a test but not listed in ${dirName}'s (dev)dependencies`);
    }
    return;
  }
  // third-party package
  const declared = deps.has(name) || (kind === 'test' && devDeps.has(name));
  if (!declared && !(kind === 'test' && isRootDevDependency(name))) {
    report(file, line, `third-party "${name}" is not declared in ${dirName}'s package.json`);
  }
}

// Test files may use the shared root toolchain (vitest, etc.).
let rootDevDeps: Set<string> | null = null;
let rootDevDepsFor = '';
function isRootDevDependency(name: string): boolean {
  const rootPkg = resolve(process.cwd(), 'package.json');
  if (rootDevDeps === null || rootDevDepsFor !== rootPkg) {
    rootDevDepsFor = rootPkg;
    rootDevDeps = existsSync(rootPkg) ? new Set(Object.keys(readJson(rootPkg).devDependencies ?? {})) : new Set();
  }
  return rootDevDeps.has(name);
}

/** Cycles in the layer table, as "a -> b -> a" strings. */
export function findCycles(layers: Readonly<Record<string, LayerRule>>): string[] {
  const cycles: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (node: string, stack: string[]): void => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'visiting') {
      cycles.push([...stack.slice(stack.indexOf(node)), node].join(' -> '));
      return;
    }
    state.set(node, 'visiting');
    for (const dep of layers[node]?.allow ?? []) if (dep !== '*') visit(dep, [...stack, node]);
    state.set(node, 'done');
  };
  for (const node of Object.keys(layers)) visit(node, []);
  return cycles;
}
