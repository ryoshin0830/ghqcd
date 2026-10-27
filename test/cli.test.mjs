// Exercises the CLI with `ghq` and `fzf` shims on PATH: no network, no real
// repositories, no TTY. The interactive fzf UI is covered by the manual matrix
// in CLAUDE.md — everything reachable without a terminal lives here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs';
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
function makeShims({ repos = REPOS, ghqStatus = 0, gh = '#!/bin/sh\nexit 1\n' } = {}) {
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
  // The developer's own `gh auth token` must not reach a test, nor the network.
  write('gh', gh);
  return dir;
}

function run(args, { shims, env = {} } = {}) {
  const dir = shims ?? makeShims();
  const childEnv = {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, NO_COLOR: '1', GHQCD_SEMANTIC: '0', ...env,
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
  if (spawnSync('fish', ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip('fish not installed');
  // fish wants a script *file*. `fish -n /dev/stdin` reads the pipe spawnSync
  // hands it on macOS but not on Linux, where it exits 127 with "Error reading
  // script file" — which is how this passed for a year and failed the first
  // time the suite ran on CI. zsh and bash take the snippet on stdin happily.
  const script = mkdtempSync(join(tmpdir(), 'gwqadd-fish-'));
  writeFileSync(join(script, 'init.fish'), run(['--init', 'fish']).stdout);
  const r = spawnSync('fish', ['-n', join(script, 'init.fish')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  rmSync(script, { recursive: true, force: true });
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
  // git too: it is checked before ghq, so omitting it would make this
  // assert the wrong missing tool.
  for (const n of ['git', 'ghq']) {
    writeFileSync(join(dir, n), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, n), 0o755);
  }
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

test('a missing git exits 127 — ghq shells out to it', () => {
  // Without git, `ghq` does not simply fail loudly: `ghq list -p` exits 1 with an empty listing,
  // which this tool would otherwise report as "no repositories".
  const dir = mkdtempSync(join(tmpdir(), 'ghqcd-nogit-'));
  for (const n of ['ghq', 'fzf']) {
    writeFileSync(join(dir, n), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, n), 0o755);
  }
  const r = spawnSync(process.execPath, [BIN, '--json', 'x'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir, NO_COLOR: '1' },
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 127);
  assert.equal(jsonLine(r.stderr).error.code, 'E_DEPS');
  assert.match(jsonLine(r.stderr).error.message, /'git' not found/);
});

// ── the emitted function, actually run ───────────────────────────────────────
//
// A syntax check never caught this: with the function installed, every flag
// whose output goes to stdout was captured and handed to `cd`. `--version`
// became "no such file or directory: ghqcd x.y.z" and `--help` became
// "file name too long". Run the function for real.

function shellRun(shell, args) {
  const init = run(['--init', shell]).stdout;
  const script = shell === 'fish'
    ? `${init}\nghqcd ${args.join(' ')}`
    : `${init}\nghqcd ${args.join(' ')}`;
  return spawnSync(shell, ['-c', script], { encoding: 'utf8' });
}

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`the ${shell} function passes --version through instead of cd'ing into it`, (t) => {
    if (spawnSync(shell, ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip(`${shell} missing`);
    const r = shellRun(shell, ['--version']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ghqcd \d+\.\d+\.\d+/m);
    assert.doesNotMatch(r.stderr, /cd:|no such file|not a directory/);
  });

  test(`the ${shell} function passes --help through`, (t) => {
    if (spawnSync(shell, ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip(`${shell} missing`);
    const r = shellRun(shell, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /USAGE/);
    assert.doesNotMatch(r.stderr, /file name too long|cd:/);
  });
}

test('the emitted snippet tells people to use `command`', () => {
  // `eval "$(<pkg> --init zsh)"` in ~/.zshrc resolves to the *function* on every
  // re-source after the first, and a stale function captures this very output
  // and hands it to cd. `command` skips functions. The header comment is the
  // line people copy, so it has to be the correct one.
  for (const shell of ['zsh', 'bash']) {
    const out = run(['--init', shell]).stdout;
    assert.match(out, /eval "\$\(command ghqcd --init (zsh|bash)\)"/,
      `${shell} header must recommend the command form`);
  }
  assert.match(run(['--init', 'fish']).stdout, /command ghqcd --init fish \| source/);
});

test('re-sourcing is idempotent even with a stale function defined', (t) => {
  if (spawnSync('zsh', ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip('zsh missing');
  const init = run(['--init', 'zsh']).stdout;
  // A pre-`command` function: captures stdout and cds into it, whatever it is.
  const stale = `ghqcd() { local d; d=$(echo stale) || return $?; builtin cd -- "$d"; }`;
  const script = [stale, init, 'ghqcd --version'].join('\n');
  const r = spawnSync('zsh', ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ghqcd \d+\.\d+\.\d+/m, 'the new function must have replaced the stale one');
  assert.doesNotMatch(r.stderr, /cd:|no such file/);
});

// ── search index (--index, --issues, --semantic) ─────────────────────────────
//
// GitHub is a local fake: GHQCD_GITHUB_API points the GraphQL client at it.
// The child runs asynchronously so this process can answer its requests.

function runAsync(args, env, shimOpts) {
  const shims = makeShims(shimOpts);
  const childEnv = { ...process.env, PATH: `${shims}:${process.env.PATH}`, NO_COLOR: '1', GHQCD_SEMANTIC: '0', ...env };
  delete childEnv.FORCE_COLOR; // see run()
  const child = spawn(process.execPath, [BIN, ...args], { env: childEnv });
  let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  return new Promise((resolve) => child.on('close', (status) => {
    rmSync(shims, { recursive: true, force: true });
    resolve({ status, stdout, stderr });
  }));
}

async function fakeGitHub() {
  const issues = {
    apple: [{ number: 7, title: 'Timeout when syncing', body: 'The upload stalls after 30 seconds.' }],
    banana: [],
    zebra: [{ number: 2, title: 'Remote issue', body: 'only on GitHub' }],
  };
  // What `viewer.repositories` returns for the github.com token ('t'): one
  // repository that is cloned in the shims and one that is not.
  const viewer = [
    { nameWithOwner: 'alice/apple', description: 'apple description', viewerPermission: 'ADMIN', pushedAt: '2026-10-01T00:00:00Z', r1: null, r2: null, r3: null },
    { nameWithOwner: 'alice/zebra', description: 'remote only', viewerPermission: 'ADMIN', pushedAt: '2026-10-02T00:00:00Z', r1: { text: 'zebra readme' }, r2: null, r3: null },
  ];
  const server = createServer((req, res) => {
    server.auth.add(req.headers.authorization);
    if (server.fail) { res.statusCode = 401; res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(body);
      if (query.includes('viewer{')) { // not viewerPermission
        // The org-wide listing (ownerAffiliations) adds a repository you only see as a member.
        // GitHub needs both filters to include ORGANIZATION_MEMBER for that.
        const orgWide = /ownerAffiliations:\[[^\]]*ORGANIZATION_MEMBER/.test(query) && /[^r]affiliations:\[[^\]]*ORGANIZATION_MEMBER/.test(query);
        const all = orgWide ? [...viewer, { nameWithOwner: 'org/kiwi', description: 'org repo', pushedAt: '2026-09-01T00:00:00Z' }] : viewer;
        const nodes = req.headers.authorization === 'bearer t' ? all : [];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: { viewer: { repositories: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } }));
        return;
      }
      const repository = query.includes('issues')
        ? { issues: { nodes: issues[variables.name] ?? [] } }
        : { description: `${variables.name} description`, viewerPermission: variables.name === 'cherry' ? 'READ' : 'ADMIN' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { repository } }));
    });
  });
  server.auth = new Set(); // every token that reached GitHub
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/graphql` };
}

test('--index refuses to run beside another --index, and takes over a dead one\'s lock', async () => {
  const cache = tempCache();
  const env = { GHQCD_CACHE_DIR: cache, GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '' };
  try {
    writeFileSync(join(cache, 'index.lock'), String(process.pid)); // this test runner: alive
    const busy = await runAsync(['--index', '--json'], env);
    assert.equal(busy.status, 1);
    assert.equal(jsonLine(busy.stderr).error.code, 'E_INDEX');
    assert.match(jsonLine(busy.stderr).error.message, /is running/);

    writeFileSync(join(cache, 'index.lock'), '2147483646'); // no such process
    const ok = await runAsync(['--index', '--json'], env);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(existsSync(join(cache, 'index.lock')), false, 'lock released on exit');
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('--index also stores repositories you can reach but have not cloned', async () => {
  const cache = tempCache();
  const gh = await fakeGitHub();
  try {
    const r = await runAsync(['--index', '--json'], { GHQCD_CACHE_DIR: cache, GHQCD_GITHUB_API: gh.url, GH_TOKEN: 't', GH_ENTERPRISE_TOKEN: 'e', GH_HOST: 'git.example.com' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).remote, 2, 'zebra (yours) and kiwi (your org)');
    const { repos } = JSON.parse(readFileSync(join(cache, 'index.json'), 'utf8'));
    const zebra = repos['github.com/alice/zebra'];
    assert.equal(zebra.cloned, false);
    assert.equal(zebra.description, 'remote only');
    assert.equal(zebra.readme, 'zebra readme');
    assert.equal(zebra.issues[0].number, 2);
    assert.equal(repos[REPOS[0]].cloned, true);
    assert.equal(Object.values(repos).filter((x) => x.slug === 'github.com/alice/apple').length, 1, 'a clone is not listed twice');
    const done = JSON.parse(readFileSync(join(cache, 'progress.json'), 'utf8'));
    assert.equal(done.done, true, 'the window\'s status bar learns that the run finished');
    assert.match(done.text, /^indexed 5 repositories/);
    // Repositories you only see as an org member: name and description, no README or issues.
    assert.deepEqual([repos['github.com/org/kiwi'].description, repos['github.com/org/kiwi'].readme, repos['github.com/org/kiwi'].lite], ['org repo', '', true]);
    assert.equal(repos['github.com/alice/zebra'].lite, undefined, 'your own repository keeps its README');
  } finally {
    gh.server.close();
    rmSync(cache, { recursive: true, force: true });
  }
});

test('--index sends GH_ENTERPRISE_TOKEN to GH_HOST only, not to every host as gh would', async () => {
  const cache = tempCache();
  const gh = await fakeGitHub();
  const env = { GHQCD_CACHE_DIR: cache, GHQCD_GITHUB_API: gh.url, GH_TOKEN: 't', GH_ENTERPRISE_TOKEN: 'e' };
  // Like the real one: `gh auth token --hostname <any host but github.com>` prints the enterprise token.
  const realGh = { gh: '#!/bin/sh\nt="${GH_ENTERPRISE_TOKEN:-$GITHUB_ENTERPRISE_TOKEN}"\n[ -n "$t" ] || exit 1\necho "$t"\n' };
  try {
    await runAsync(['--index', '--json'], { ...env, GH_HOST: 'ghe.example.com' }, realGh); // cherry is on git.example.com
    assert.equal(gh.server.auth.has('bearer e'), false, 'a host other than GH_HOST got the enterprise token');
    await runAsync(['--index', '--json'], { ...env, GH_HOST: 'git.example.com' });
    assert.equal(gh.server.auth.has('bearer e'), true);
  } finally {
    gh.server.close();
    rmSync(cache, { recursive: true, force: true });
  }
});

test('--index says that GH_ENTERPRISE_TOKEN without GH_HOST is ignored', async () => {
  const cache = tempCache();
  const gh = await fakeGitHub();
  try {
    const r = await runAsync(['--index', '--json'], { GHQCD_CACHE_DIR: cache, GHQCD_GITHUB_API: gh.url, GH_TOKEN: 't', GH_ENTERPRISE_TOKEN: 'e', GH_HOST: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /GH_ENTERPRISE_TOKEN is ignored without GH_HOST/);
    assert.match(JSON.parse(readFileSync(join(cache, 'progress.json'), 'utf8')).hint, /GH_HOST/, 'the window\'s footer says it too');
  } finally {
    gh.server.close();
    rmSync(cache, { recursive: true, force: true });
  }
});

test('--json finds a matching clone even when hundreds of repositories that are not cloned rank higher', () => {
  const cache = tempCache();
  const repos = { [REPOS[1]]: { slug: 'github.com/alice/banana', name: 'banana', cloned: true, readme: 'a client for the api', issues: [] } };
  for (let i = 0; i < 250; i++) repos[`github.com/org/api-${i}`] = { slug: `github.com/org/api-${i}`, name: `api-${i}`, cloned: false, lite: true, issues: [] };
  writeFileSync(join(cache, 'index.json'), JSON.stringify({ repos }));
  const r = run(['--json', 'api'], { env: { GHQCD_CACHE_DIR: cache } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).path, REPOS[1]);
  rmSync(cache, { recursive: true, force: true });
});

test('--index keeps what it knew about a repository cloned since the last run', async () => {
  const cache = tempCache();
  const gh = await fakeGitHub();
  const env = { GHQCD_CACHE_DIR: cache, GHQCD_GITHUB_API: gh.url, GH_TOKEN: 't' };
  const zebra = `${ROOT}/github.com/alice/zebra`;
  try {
    await runAsync(['--index', '--json'], env); // zebra is not cloned: keyed by its slug
    gh.server.fail = true; // then it is cloned, and GitHub cannot be reached
    const r = await runAsync(['--index', '--json'], env, { repos: [...REPOS, zebra] });
    assert.equal(r.status, 0, r.stderr);
    const { repos } = JSON.parse(readFileSync(join(cache, 'index.json'), 'utf8'));
    assert.deepEqual([repos[zebra].description, repos[zebra].issues.map((i) => i.number)], ['remote only', [2]]);
  } finally {
    gh.server.close();
    rmSync(cache, { recursive: true, force: true });
  }
});

test('--index without a token tells the window how to add GitHub, and locks the cache dir down', async () => {
  const cache = tempCache();
  chmodSync(cache, 0o755);
  const r = await runAsync(['--index', '--json'], { GHQCD_CACHE_DIR: cache, GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(readFileSync(join(cache, 'progress.json'), 'utf8')).hint, /gh auth login/);
  assert.equal(statSync(cache).mode & 0o777, 0o700, 'the sockets in it rely on this');
  rmSync(cache, { recursive: true, force: true });
});

function tempCache() {
  return mkdtempSync(join(tmpdir(), 'ghqcd-cache-'));
}

test('--issues and --semantic are gone: one window searches everything', () => {
  assert.equal(run(['--issues', '--json', 'x']).status, 1);
  assert.equal(run(['--semantic', '--json', 'x']).status, 1);
  assert.equal(jsonLine(run(['--index', '--json', 'x']).stderr).error.code, 'E_VALIDATION');
});

test('--json finds a clone by an issue, and says which issue', async () => {
  const cache = tempCache();
  const gh = await fakeGitHub();
  try {
    await runAsync(['--index', '--json'], { GHQCD_CACHE_DIR: cache, GHQCD_GITHUB_API: gh.url, GH_TOKEN: 't', GH_ENTERPRISE_TOKEN: 'e', GH_HOST: 'git.example.com' });
    const r = run(['--json', 'stalls'], { env: { GHQCD_CACHE_DIR: cache } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([JSON.parse(r.stdout).path, JSON.parse(r.stdout).issue], [REPOS[0], 7]);
    const apple = JSON.parse(run(['--json', 'apple'], { env: { GHQCD_CACHE_DIR: cache } }).stdout);
    assert.equal(apple.path, REPOS[0]);
  } finally {
    gh.server.close();
    rmSync(cache, { recursive: true, force: true });
  }
});

test('--json never picks a repository that is not cloned, and says how to clone it', async () => {
  const cache = tempCache();
  const gh = await fakeGitHub();
  try {
    await runAsync(['--index', '--json'], { GHQCD_CACHE_DIR: cache, GHQCD_GITHUB_API: gh.url, GH_TOKEN: 't', GH_ENTERPRISE_TOKEN: 'e', GH_HOST: 'git.example.com' });
    const r = run(['--json', 'zebra'], { env: { GHQCD_CACHE_DIR: cache } });
    assert.equal(r.status, 2);
    const err = jsonLine(r.stderr).error;
    assert.equal(err.code, 'E_NO_MATCH');
    assert.match(err.message, /ghq get https:\/\/github\.com\/alice\/zebra/);
  } finally {
    gh.server.close();
    rmSync(cache, { recursive: true, force: true });
  }
});

test('--json falls back to fzf on the path when no word matches, as before the index', () => {
  // `test-root/…/ap` is in the path, not in any name or slug: what fzf matched before.
  const r = run(['--json', 'test-root/github.com/alice/ap']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).path, REPOS[0]);
});

test('--json falls back to fzf on the path even when the query is a subsequence of a name not cloned', () => {
  // `alweb` is a subsequence of many of the 2,000 org names; that is not a word match.
  const cache = tempCache();
  const repos = { 'github.com/org/tests-for-root': { slug: 'github.com/org/tests-for-root', name: 'tests-for-root', cloned: false, lite: true, issues: [] } };
  writeFileSync(join(cache, 'index.json'), JSON.stringify({ repos }));
  const r = run(['--json', 'test-root'], { env: { GHQCD_CACHE_DIR: cache } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).path, REPOS[0]);
  rmSync(cache, { recursive: true, force: true });
});

test('--json alweb lands on alice/web through the real fzf, beside an org name it is a subsequence of', (t) => {
  if (spawnSync('fzf', ['--version'], { stdio: 'ignore' }).error) return t.skip('fzf not installed');
  const web = `${ROOT}/github.com/alice/web`;
  const shims = makeShims({ repos: [...REPOS, web] });
  rmSync(join(shims, 'fzf')); // the real one: its fuzzy matching is the point
  const cache = tempCache();
  const repos = { 'github.com/acme/small-webapp': { slug: 'github.com/acme/small-webapp', name: 'small-webapp', cloned: false, lite: true, issues: [] } };
  writeFileSync(join(cache, 'index.json'), JSON.stringify({ repos }));
  const r = run(['--json', 'alweb'], { shims, env: { GHQCD_CACHE_DIR: cache } });
  rmSync(shims, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).path, web);
});

test('--json without any index still ranks clones by name, and starts no indexing', () => {
  const cache = tempCache();
  const r = run(['--json', 'banana'], { env: { GHQCD_CACHE_DIR: cache } });
  assert.equal(JSON.parse(r.stdout).path, REPOS[1]);
  assert.equal(existsSync(join(cache, 'index.json')), false);
  assert.equal(existsSync(join(cache, 'progress.json')), false);
  rmSync(cache, { recursive: true, force: true });
});

test('--index stores issues of writable repos and keeps them when the token fails', async () => {
  const cache = tempCache();
  const gh = await fakeGitHub();
  const env = { GHQCD_CACHE_DIR: cache, GHQCD_GITHUB_API: gh.url, GH_TOKEN: 't', GH_ENTERPRISE_TOKEN: 'e', GH_HOST: 'git.example.com' };
  try {
    const idx = await runAsync(['--index', '--json'], env);
    assert.equal(idx.status, 0, idx.stderr);
    const out = JSON.parse(idx.stdout);
    assert.equal(out.repos, 3);
    assert.match(idx.stderr, /✓ indexed 5 repositories in \d+ s · 2 issues/, "one receipt line, counting the repositories that are not cloned");
    assert.equal(out.issues, 2, 'apple (cloned) and zebra (not cloned)');
    assert.equal(statSync(join(cache, 'index.json')).mode & 0o777, 0o600, 'issue text is private');

    const plain = JSON.parse(run(['--json', 'cherry'], { env: { GHQCD_CACHE_DIR: cache } }).stdout);
    assert.equal(plain.path, REPOS[2]);
    assert.equal(plain.issue, undefined, 'found by name, not by an issue');

    // A rejected token keeps the issues the last run fetched.
    gh.server.fail = true;
    const bad = await runAsync(['--index', '--json'], env);
    assert.equal(JSON.parse(bad.stdout).errors, 2, 'one per host: a host that refused the token is not asked again per repository');
    assert.match(bad.stderr, /HTTP 401/);
    assert.equal(JSON.parse(readFileSync(join(cache, 'index.json'), 'utf8')).repos['github.com/alice/zebra'].readme, 'zebra readme',
      'a repository that is not cloned survives a rejected token too');
    assert.equal(JSON.parse(run(['--json', 'stalls'], { env: { GHQCD_CACHE_DIR: cache } }).stdout).issue, 7);

    // The run is timed, and an index older than a week is pointed out, not silently used.
    const status = JSON.parse(readFileSync(join(cache, 'status.json'), 'utf8'));
    assert.ok(Date.now() - status.textAt < 60000 && status.textSeconds >= 0);
    writeFileSync(join(cache, 'status.json'), JSON.stringify({ ...status, textAt: Date.now() - 10 * 864e5 }));
    assert.match(run(['--json', 'stalls'], { env: { GHQCD_CACHE_DIR: cache } }).stderr, /10 days old/);

    // So does having no token at all.
    const none = await runAsync(['--index', '--json'], { GHQCD_CACHE_DIR: cache, GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '' });
    assert.equal(JSON.parse(none.stdout).skipped, 3);
    assert.equal(JSON.parse(run(['--json', 'stalls'], { env: { GHQCD_CACHE_DIR: cache } }).stdout).issue, 7);
  } finally {
    gh.server.close();
    rmSync(cache, { recursive: true, force: true });
  }
});
