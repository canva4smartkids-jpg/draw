#!/usr/bin/env node
// Fetch the real CorelDRAW regression files used by the io-cdr tests.
//
// They come from LibreOffice's import-filter test data (MPL-2.0) and are not
// committed here. Only the three small files are checked out (sparse,
// blob-filtered clone), then verified against pinned SHA-256 hashes.
// Cross-platform: needs only git and Node.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_DIR, FIXTURE_SHA256, sha256 } from '@draw/testkit';

const REPO = 'https://github.com/LibreOffice/core.git';
const SOURCES: Readonly<Record<string, string>> = {
  'fdo65220-2.cdr': 'writerperfect/qa/unit/data/draw/libcdr/pass/fdo65220-2.cdr',
  'EDB-35217-2.cdr': 'writerperfect/qa/unit/data/draw/libcdr/pass/EDB-35217-2.cdr',
  'fdo63782-1.cmx': 'writerperfect/qa/unit/data/draw/libcdr-cmx/pass/fdo63782-1.cmx',
};

function verified(name: string): boolean {
  const path = join(FIXTURE_DIR, name);
  return existsSync(path) && sha256(readFileSync(path)) === FIXTURE_SHA256[name];
}

const missing = Object.keys(SOURCES).filter((name) => !verified(name));
if (missing.length === 0) {
  console.log(`fixtures already present and verified in ${FIXTURE_DIR}`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'draw-fixtures-'));
try {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });
  };
  git('clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', REPO, 'core');
  const core = join(work, 'core');
  execFileSync('git', ['sparse-checkout', 'set', '--no-cone', ...Object.values(SOURCES)], { cwd: core });
  execFileSync('git', ['checkout', '--quiet'], { cwd: core });

  mkdirSync(FIXTURE_DIR, { recursive: true });
  let failed = false;
  for (const [name, source] of Object.entries(SOURCES)) {
    copyFileSync(join(core, source), join(FIXTURE_DIR, name));
    const ok = verified(name);
    console.log(`${name}: ${ok ? 'OK' : 'HASH MISMATCH'}`);
    failed ||= !ok;
  }
  if (failed) {
    console.error('one or more fixtures changed upstream; review before updating FIXTURE_SHA256');
    process.exit(1);
  }
  console.log(`fixtures ready in ${FIXTURE_DIR}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
