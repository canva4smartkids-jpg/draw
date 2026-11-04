// Access to real-world fixture files fetched by `npm run fixtures`.
// They are third-party files (see tools/fetch-fixtures.ts), so they are not
// committed; tests that need them skip when they are absent.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Absolute path of the shared fixture directory (repo-root/fixtures/external). */
export const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/external/', import.meta.url));

/** Expected SHA-256 of every known fixture; loadFixture() refuses anything else. */
export const FIXTURE_SHA256: Readonly<Record<string, string>> = {
  'fdo65220-2.cdr': '88e62beb7a7ebe812f6ce06238017d07d215de9dbf76323dde93200f2d5dd348',
  'EDB-35217-2.cdr': '10bbe0e281b70ca7b95c2f134191e099419c7b3a6c5899cd9d3474a7081d42df',
  'fdo63782-1.cmx': '14c29eedec0d6e2b2cc2588bdee9997d0875364a2e6b0cde7ee1ee4620493e80',
};

export const fixturePath = (name: string): string => FIXTURE_DIR + name;

export const hasFixture = (name: string): boolean => existsSync(fixturePath(name));

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read a fixture and verify its hash, so tests never run against a changed file. */
export function loadFixture(name: string): Uint8Array {
  const expected = FIXTURE_SHA256[name];
  if (!expected) throw new Error(`unknown fixture ${name}`);
  const bytes = new Uint8Array(readFileSync(fixturePath(name)));
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`fixture ${name} has sha256 ${actual}, expected ${expected}`);
  return bytes;
}

/** Message for test.skipIf when a fixture is missing. */
export const missingFixture = (name: string): string => `run "npm run fixtures" to fetch ${name}`;
