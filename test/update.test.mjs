import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNewer } from '../lib/update.mjs';
import { windowFixture } from './fixtures/window.mjs';

test('compares npm versions including prereleases and rejects invalid versions', () => {
  for (const [latest, current, newer] of [
    ['0.10.0', '0.9.9', true], ['1.0.0', '1.0.0', false],
    ['0.9.0', '1.0.0', false], ['1.0.0', '1.0.0-rc.1', true],
    ['1.0.0-rc.10', '1.0.0-rc.2', true], ['1.0.0-alpha', '1.0.0', false],
    ['1.0.0-alpha.1', '1.0.0-alpha', true], ['1.0.0+build', '1.0.0', false],
    ['1.0.0; touch /tmp/no', '1.0.0', false], ['1.0.0-01', '1.0.0', false],
  ]) assert.equal(isNewer(latest, current), newer, `${latest} vs ${current}`);
});

function fixture() {
  const f = windowFixture({ vectors: false });
  delete f.env.NO_UPDATE_NOTIFIER;
  f.env.NPM_CALLS = join(f.base, 'npm-calls');
  writeFileSync(join(f.shims, 'npm'), `#!/bin/sh
printf '%s\\n' "$*" >> "$NPM_CALLS"
case "$1" in
  view) [ "$NPM_OFFLINE" = 1 ] && exit 1; echo "\${NPM_TEST_VERSION:-999.0.0}" ;;
  install) [ "$NPM_FAIL_INSTALL" = 1 ] && exit 1; echo installed ;;
esac
`, { mode: 0o755 });
  return f;
}

function runPty(f, choice, shell = false) {
  const script = join(f.base, 'update.exp');
  const cmd = shell
    ? `spawn -noecho bash -c {eval "$(node ${f.bin} --init bash)"; ghqcd apple; printf 'CWD=%s\\n' "$PWD"}`
    : `spawn -noecho ${process.execPath} ${f.bin} --quiet apple`;
  writeFileSync(script, `set timeout 10
${cmd}
expect {
  -exact {Choose 1 or 2 [2]: } { send -- "${choice}" }
  timeout { puts stderr "missing update prompt"; exit 91 }
  eof { puts stderr "closed before update prompt"; exit 92 }
}
expect eof
catch wait result
exit [lindex $result 3]
`);
  return spawnSync('expect', [script], { env: f.env, encoding: 'utf8', timeout: 15000 });
}

test('E2E: updating runs npm without changing the shell directory', (t) => {
  if (spawnSync('expect', ['-v'], { stdio: 'ignore' }).error) {
    assert.notEqual(process.env.GHQCD_E2E_REQUIRED, '1'); return t.skip('expect is not installed');
  }
  const f = fixture();
  try {
    const r = runPty(f, '1', true);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Update available: .* → 999\.0\.0/);
    assert.match(r.stdout, /Update complete/);
    assert.doesNotMatch(r.stdout, new RegExp(`CWD=${f.repos[0]}`));
    assert.match(r.stdout, /Run ghqcd again/);
    assert.match(readFileSync(f.env.NPM_CALLS, 'utf8'), /install --global ghqcd@999\.0\.0 --ignore-scripts/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('E2E: declining or a failed installation continues to the selected repository', (t) => {
  if (spawnSync('expect', ['-v'], { stdio: 'ignore' }).error) {
    assert.notEqual(process.env.GHQCD_E2E_REQUIRED, '1'); return t.skip('expect is not installed');
  }
  for (const [choice, failure] of [['2', false], ['1', true]]) {
    const f = fixture();
    if (failure) f.env.NPM_FAIL_INSTALL = '1';
    try {
      const r = runPty(f, choice, !failure);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(r.stdout.includes(failure ? f.repos[0] : `CWD=${f.repos[0]}`), r.stdout);
      const calls = readFileSync(f.env.NPM_CALLS, 'utf8');
      assert.equal(calls.includes('install --global'), failure);
      if (failure) assert.match(r.stdout, /Update failed/);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  }
});

test('noninteractive commands do not check npm or change stdout', () => {
  const f = fixture();
  try {
    const r = spawnSync(process.execPath, [f.bin, '--search', '--json', 'apple'], { env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).results[0].path, f.repos[0]);
    assert.equal(existsSync(f.env.NPM_CALLS), false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('E2E: an offline registry or current version does not interrupt startup', (t) => {
  if (spawnSync('expect', ['-v'], { stdio: 'ignore' }).error) {
    assert.notEqual(process.env.GHQCD_E2E_REQUIRED, '1'); return t.skip('expect is not installed');
  }
  for (const env of [{ NPM_OFFLINE: '1' }, { NPM_TEST_VERSION: '0.0.1' }]) {
    const f = fixture();
    Object.assign(f.env, env);
    try {
      const script = join(f.base, 'no-update.exp');
      writeFileSync(script, `set timeout 10
spawn -noecho ${process.execPath} ${f.bin} --quiet apple
expect {
  -exact {Choose 1 or 2} { puts stderr "unexpected update prompt"; exit 91 }
  timeout { puts stderr "startup timed out"; exit 92 }
  eof {}
}
catch wait result
exit [lindex $result 3]
`);
      const r = spawnSync('expect', [script], { env: f.env, encoding: 'utf8', timeout: 15000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(r.stdout.includes(f.repos[0]), r.stdout);
      assert.doesNotMatch(readFileSync(f.env.NPM_CALLS, 'utf8'), /install/);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  }
});
