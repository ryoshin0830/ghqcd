// Exercises the CLI with `ghq` and `fzf` shims on PATH: no network, no real
// repositories, no TTY. The interactive fzf UI is covered by the manual matrix
// in CLAUDE.md — everything reachable without a terminal lives here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ghqcd.mjs');
const ROOT = '/tmp/ghqcd-test-root';
const REPOS = [
  `${ROOT}/github.com/alice/apple`,
  `${ROOT}/github.com/alice/banana`,
  `${ROOT}/git.example.com/team/cherry`,
];

// A shim dir that satisfies both `ghq` and `fzf` well enough for the
// non-interactive paths. `fzf --filter` is a substring match — close enough
// to fzf's ranking for tests that only assert which candidates survive.
function makeShims({ repos = REPOS, ghqStatus = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ghqcd-shims-'));
  const write = (name, body) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };
  write('ghq', `#!/bin/sh
case "$1" in
  --version) echo "ghq version 1.6.1" ;;
  root)      echo "${ROOT}" ;;
  list)      exit ${ghqStatus}; ;;
esac
exit 0
`.replace('list)      exit ' + ghqStatus + '; ;;',
    ghqStatus === 0
      ? `list)      printf '%s\\n' ${repos.map((r) => `'${r}'`).join(' ')} ;;`
      : `list)      echo "ghq: boom" >&2; exit ${ghqStatus} ;;`));

  write('fzf', `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.74.1"; exit 0; fi
if [ "$1" = "--filter" ]; then
  out=$(grep -F -- "$2")
  [ -n "$out" ] || exit 1
  printf '%s\\n' "$out"
  exit 0
fi
# No TTY in tests, so the interactive branch must never be reached.
echo "fzf: interactive UI invoked in a test" >&2
exit 2
`);
  return dir;
}

function run(args, { shims, env = {} } = {}) {
  const dir = shims ?? makeShims();
  const childEnv = {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, NO_COLOR: '1', ...env,
  };
  // We force NO_COLOR; node itself warns to stderr when FORCE_COLOR is also
  // set, so a developer who exports it would otherwise see phantom failures.
  delete childEnv.FORCE_COLOR;
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: childEnv });
  if (!shims) rmSync(dir, { recursive: true, force: true });
  return r;
}

const jsonLine = (s) =>
  JSON.parse(s.split('\n').find((l) => l.startsWith('{')));

// stderr is shared, not ours alone: node emits its own warnings there. Strip
// them before asserting the program itself stayed silent.
const ourStderr = (s) =>
  s.split('\n')
    .filter((l) => l && !/^\(node:\d+\)/.test(l) && !/^\(Use `node --trace-warnings/.test(l))
    .join('\n');

// ── --init ───────────────────────────────────────────────────────────────────

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`--init ${shell} emits a function and the three-step resolver`, () => {
    const r = run(['--init', shell]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ghqcd/);
    assert.match(r.stdout, /--quiet/, 'the function must call the binary in --quiet mode');
    assert.match(r.stdout, /npx -y/, 'npx must be the last-resort fallback');
    assert.ok(r.stdout.includes(BIN), 'the generating script path must be baked in');
    assert.equal(ourStderr(r.stderr), '');
  });
}

for (const [shell, checker] of [['zsh', 'zsh'], ['bash', 'bash']]) {
  test(`--init ${shell} output parses under ${checker} -n`, (t) => {
    const probe = spawnSync(checker, ['-c', 'true'], { stdio: 'ignore' });
    if (probe.error) return t.skip(`${checker} not installed`);
    const src = run(['--init', shell]).stdout;
    const r = spawnSync(checker, ['-n'], { input: src, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('--init fish output parses under fish -n', (t) => {
  const probe = spawnSync('fish', ['-c', 'true'], { stdio: 'ignore' });
  if (probe.error) return t.skip('fish not installed');
  const src = run(['--init', 'fish']).stdout;
  const r = spawnSync('fish', ['-n', '/dev/stdin'], { input: src, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('--cmd renames the emitted function', () => {
  const r = run(['--init', 'zsh', '--cmd', 'gcd']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^gcd\(\) \{/m);
});

test('--init rejects an unknown shell', () => {
  const r = run(['--init', 'tcsh']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /zsh \| bash \| fish/);
});

test('--cmd without --init is a validation error', () => {
  const r = run(['--cmd', 'gcd']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only meaningful together with --init/);
});

// ── flags ────────────────────────────────────────────────────────────────────

test('--help exits 0 on stdout', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /USAGE/);
  assert.equal(ourStderr(r.stderr), '');
});

test('--version matches package.json', async () => {
  const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
  const r = run(['--version']);
  assert.equal(r.stdout.trim(), `ghqcd ${pkg.version}`);
});

test('--json and --quiet are mutually exclusive', () => {
  const r = run(['--json', '--quiet']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_VALIDATION');
});

test('a second positional is rejected', () => {
  const r = run(['one', 'two']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unexpected extra arguments: two/);
});

test('--query conflicting with the positional is rejected', () => {
  const r = run(['--query', 'a', 'b']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /conflicts with positional/);
});

// ── listing and selection ────────────────────────────────────────────────────

test('--list prints every repository path', () => {
  const r = run(['--list']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split('\n'), REPOS);
});

test('--list narrows to the query', () => {
  const r = run(['--list', 'alice']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split('\n').length, 2);
});

test('--list --json carries count, root and slugs', () => {
  const r = run(['--list', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.count, 3);
  assert.equal(out.root, ROOT);
  assert.equal(out.repos[0].slug, 'github.com/alice/apple');
});

test('--json picks the best match and reports how many there were', () => {
  const r = run(['--json', 'alice']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.path, REPOS[0]);
  assert.equal(out.slug, 'github.com/alice/apple');
  assert.equal(out.matches, 2, 'an ambiguous query must say so');
});

test('--quiet prints the path and nothing else on stdout', () => {
  const r = run(['--quiet', 'cherry']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${REPOS[2]}\n`);
});

test('no match exits 2 with E_NO_MATCH', () => {
  const r = run(['--json', 'durian']);
  assert.equal(r.status, 2);
  assert.equal(jsonLine(r.stderr).error.code, 'E_NO_MATCH');
  assert.equal(r.stdout, '', 'stdout stays empty on error (I1)');
});

test('no query without a TTY exits 3 with E_AMBIGUOUS', () => {
  const r = run(['--json']);
  assert.equal(r.status, 3);
  assert.equal(jsonLine(r.stderr).error.code, 'E_AMBIGUOUS');
});

test('an empty ghq exits 2 with actionable advice', () => {
  const shims = makeShims({ repos: [] });
  const r = run(['--json', 'x'], { shims });
  rmSync(shims, { recursive: true, force: true });
  assert.equal(r.status, 2);
  assert.match(jsonLine(r.stderr).error.message, /ghq get/);
});

test('a failing ghq list surfaces as E_GHQ', () => {
  const shims = makeShims({ ghqStatus: 1 });
  const r = run(['--json', 'x'], { shims });
  rmSync(shims, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_GHQ');
});

// ── dependency check ─────────────────────────────────────────────────────────

test('a missing fzf exits 127 with the brew command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghqcd-noshim-'));
  writeFileSync(join(dir, 'ghq'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'ghq'), 0o755);
  const r = spawnSync(process.execPath, [BIN, '--json', 'x'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir, NO_COLOR: '1' },
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 127);
  const err = jsonLine(r.stderr);
  assert.equal(err.error.code, 'E_DEPS');
  assert.match(err.error.message, /brew install fzf/);
});
