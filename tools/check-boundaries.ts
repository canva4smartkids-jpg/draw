#!/usr/bin/env node
// Enforce the package layering rules. Exit code 1 on any violation.

import { fileURLToPath } from 'node:url';
import { checkBoundaries } from './boundaries.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const violations = checkBoundaries(root);
for (const v of violations) console.error(`${v.file}:${v.line}: ${v.message}`);
if (violations.length) {
  console.error(`\n${violations.length} boundary violation(s)`);
  process.exit(1);
}
console.log('package boundaries OK');
