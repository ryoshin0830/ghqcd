import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { windowFixture } from './fixtures/window.mjs';
import { MODEL } from '../lib/search-index.mjs';

const supported = (t) => {
  const missing = (reason) => {
    assert.notEqual(process.env.GHQCD_E2E_REQUIRED, '1', reason);
    t.skip(reason); return false;
  };
  for (const cmd of ['fzf', 'expect']) if (spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error) {
    return missing(`${cmd} is not installed`);
  }
  if (spawnSync('fzf', ['--filter=x', '--footer=x'], { input: 'x\n', stdio: ['pipe', 'ignore', 'ignore'] }).status !== 0) {
    return missing('fzf has no live footer support');
  }
  return true;
};

function runPty(f, script, columns = 80) {
  const path = join(f.base, 'window.exp');
  writeFileSync(path, `set timeout 15
log_user 1
spawn -noecho ${process.execPath} ${f.bin} --quiet
stty rows 30 columns ${columns} < $spawn_out(slave,name)
proc see {text} {
  expect {
    -exact "\\033\\[6n" { send -- "\\033\\[1;1R"; exp_continue }
    -exact $text { return }
    timeout { puts stderr "missing: $text"; exit 91 }
    eof { puts stderr "closed before: $text"; exit 92 }
  }
}
proc phase {text} {
  set f [open ${f.env.GHQCD_TEST_PHASE} w]; puts -nonewline $f $text; close $f
}
proc waitEvents {kind count} {
  set deadline [expr {[clock milliseconds] + 10000}]
  while {[clock milliseconds] < $deadline} {
    if {[file exists ${f.env.GHQCD_TEST_VECTOR_LOG}]} {
      set f [open ${f.env.GHQCD_TEST_VECTOR_LOG} r]; set data [read $f]; close $f
      if {[regexp -all [format {"kind":"%s"} $kind] $data] >= $count} { return }
    }
    after 20
  }
  puts stderr "missing vector event: $kind $count"; exit 93
}
proc waitFile {path} {
  set deadline [expr {[clock milliseconds] + 10000}]
  while {[clock milliseconds] < $deadline} {
    if {[file exists $path]} { return }
    after 20
  }
  puts stderr "missing file: $path"; exit 94
}
proc waitProgress {text} {
  set deadline [expr {[clock milliseconds] + 10000}]
  while {[clock milliseconds] < $deadline} {
    set f [open ${join(f.cache, 'progress.json')} r]; set data [read $f]; close $f
    if {[string first $text $data] >= 0} { return }
    after 20
  }
  puts stderr "missing progress: $text"; exit 95
}
${script}
expect eof
catch wait result
exit [lindex $result 3]
`);
  return spawnSync('expect', [path], { env: f.env, encoding: 'utf8', timeout: 40000, maxBuffer: 2e6 });
}

test('E2E: real fzf toggles vectors, keeps the query, frees the worker and reuses its cache', (t) => {
  if (!supported(t)) return;
  const f = windowFixture();
  const vectorFile = join(f.cache, `vectors-${MODEL.key}.f32`);
  const before = readFileSync(vectorFile);
  try {
    const r = runPty(f, `
see {vectors: OFF (disabled) · shift-tab: enable}
send -- needle
after 400
phase on
send -- "\\033\\[Z"
after 700
send -- "\\014"
see {vectors: ON (enabled) · shift-tab: disable}
waitEvents query 1
send -- "\\014"
see {~readme}
phase off
send -- "\\033\\[Z"
after 700
send -- "\\014"
see {vectors: OFF (disabled) · shift-tab: enable}
phase off-settled
after 400
phase again
send -- "\\033\\[Z"
after 700
send -- "\\014"
see {vectors: ON (enabled) · shift-tab: disable}
waitEvents query 2
send -- "\\014"
see {~readme}
send -- "\\r"
`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(f.repos[1]));
    assert.match(r.stdout, /updated 2 h ago/);
    assert.match(r.stdout, /~readme/);
    assert.doesNotMatch(r.stdout, /53 s|indexing failed/);
    const events = readFileSync(f.env.GHQCD_TEST_VECTOR_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.filter((e) => e.kind === 'load').map((e) => e.phase), ['on', 'again']);
    assert.equal(events.some((e) => e.phase === 'initial' || e.phase === 'off-settled'), false, 'off mode must not keep a model worker alive');
    assert.deepEqual(readFileSync(vectorFile), before);
    assert.deepEqual(JSON.parse(readFileSync(join(f.cache, 'settings.json'), 'utf8')), { semantic: true }, 'the next window starts where this one ended');
    assert.ok(existsSync(join(f.cache, 'models', MODEL.key, 'model_fp16.onnx')));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('E2E: a 60-column window shows phase progress and exits cleanly', (t) => {
  if (!supported(t)) return;
  const f = windowFixture();
  writeFileSync(join(f.cache, 'progress.json'), JSON.stringify({
    pid: process.pid, since: Date.now() - 540e3, at: Date.now(), phase: 'embedding',
    completed: 210, total: 852, remainingSeconds: 1200,
    text: 'embedding 210 of 852 · about 20 min left',
  }));
  try {
    const r = runPty(f, `
see {25% 210/852}
see {20 min left}
see {vectors: OFF (disabled) · shift-tab: enable}
send -- "\\033\\[Z"
see {vectors: ON (enabled) · shift-tab: disable}
send -- "\\033\\[Z"
see {vectors: OFF (disabled) · shift-tab: enable}
send -- "\\033"
`, 60);
    assert.equal(r.status, 130, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /53 s|indexing failed|Warning:/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('E2E: disabling pauses an owned vector build, keeps its model and lets ctrl-r refresh text', (t) => {
  if (!supported(t)) return;
  const f = windowFixture({ vectors: false });
  const started = join(f.base, 'npm-started');
  writeFileSync(join(f.shims, 'npm'), `#!/bin/sh\ntouch '${started}'\nexec sleep 30\n`, { mode: 0o755 });
  try {
    const r = runPty(f, `
see {vectors: OFF (disabled) · shift-tab: enable}
send -- "\\033\\[Z"
see {vectors: ON (enabled) · shift-tab: disable}
waitFile ${started}
send -- "\\033\\[Z"
after 700
send -- "\\014"
see {vectors: OFF (disabled) · shift-tab: enable}
waitProgress {progress saved}
file copy ${join(f.cache, 'progress.json')} ${join(f.base, 'paused.json')}
send -- "\\022"
after 700
send -- "\\014"
see {updated just now}
send -- "\\033"
`);
    assert.equal(r.status, 130, r.stdout.slice(-3000) + r.stderr);
    assert.equal(existsSync(join(f.cache, 'index.lock')), false);
    const p = JSON.parse(readFileSync(join(f.cache, 'progress.json'), 'utf8'));
    assert.equal(p.done, true);
    assert.notEqual(p.failed, true);
    assert.match(p.text, /indexed/);
    const paused = JSON.parse(readFileSync(join(f.base, 'paused.json'), 'utf8'));
    assert.equal(paused.failed, undefined);
    assert.match(paused.text, /progress saved/);
    assert.doesNotMatch(r.stdout, /indexing failed|npm ci failed|Warning:/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('E2E: legacy fzf queues vectors when enabled during a text refresh', (t) => {
  if (!supported(t)) return;
  const f = windowFixture();
  const realFzf = spawnSync('which', ['fzf'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(f.shims, 'fzf'), `#!/bin/sh\ncase "$1" in --filter=x) exit 2;; esac\nexec '${realFzf}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(f.shims, 'gh'), '#!/bin/sh\nsleep 1\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(f.cache, 'status.json'), JSON.stringify({ textAt: Date.now() - 2 * 864e5 }));
  try {
    const r = runPty(f, `
see {vectors: OFF (disabled) · shift-tab: enable}
waitFile ${join(f.cache, 'index.lock')}
send -- "\\033\\[Z"
see {vectors: ON (enabled) · shift-tab: disable}
waitEvents load 1
waitProgress {"done":true}
send -- "\\033"
`, 150);
    assert.equal(r.status, 130, r.stdout.slice(-3000) + r.stderr);
    const events = readFileSync(f.env.GHQCD_TEST_VECTOR_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(events.some((e) => e.kind === 'load' && e.threadId === 0), 'the queued background vector indexer ran');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('E2E: a killed vector indexer reports failure without a retry loop', (t) => {
  if (!supported(t)) return;
  const f = windowFixture({ vectors: false });
  const attempts = join(f.base, 'attempts');
  writeFileSync(join(f.shims, 'npm'), `#!/bin/sh\nprintf x >> '${attempts}'\nkill -KILL "$PPID"\nexit 0\n`, { mode: 0o755 });
  try {
    const r = runPty(f, `
see {vectors: OFF (disabled) · shift-tab: enable}
send -- "\\033\\[Z"
see {vectors: ON (enabled) · shift-tab: disable}
waitFile ${attempts}
waitProgress {indexer stopped}
after 1200
send -- "\\033"
`);
    assert.equal(r.status, 130, r.stdout.slice(-3000) + r.stderr);
    assert.equal(readFileSync(attempts, 'utf8'), 'x', 'a crashed model install must not be retried every tick');
    const p = JSON.parse(readFileSync(join(f.cache, 'progress.json'), 'utf8'));
    assert.equal(p.failed, true);
    assert.match(p.text, /SIGKILL/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
