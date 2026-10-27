# Refresh Status and Vector Toggle Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task in the current session. Steps use checkboxes for tracking.

**Goal:** Show useful refresh progress and make local vector search an explicit Shift+Tab opt-in.

**Architecture:** Keep fzf's query server and incremental index. Format status in a pure module, report structured work counts from the index, and switch the search worker and owned background vector jobs with window-local state.

**Tech Stack:** Node.js ESM, node:test, fzf, expect (PTY E2E); no new dependencies.

## Global Constraints

- A new installation starts with vector search off.
- Disabling must not uninstall the model or delete built vectors.
- `GHQCD_SEMANTIC=1` explicitly opts in at launch and for foreground `--index`.
- No runtime dependencies are added.
- Existing noninteractive JSON output contracts are unchanged.
- Cache files remain owner-only.

## Task 1: Useful refresh status

**Files:** Create `lib/status.mjs`, `test/status.test.mjs`; modify `lib/search-index.mjs` and `bin/ghqcd.mjs`.

**Interfaces:** `indexStatus(status, progress, { now })` returns the refresh summary or index age. Progress callbacks accept `(text, details = {})`; details contain `phase`, `completed`, `total`, `remainingSeconds`. The caller supplies only a currently live progress record or a finished receipt.

- [x] Write failing tests for age, absent index, the reported 210/852 example,
  unknown totals, completed refreshes and errors. For example:

  ```js
  const text = indexStatus({ textAt: now - 7200e3 }, {
    phase: 'embedding', completed: 210, total: 852, remainingSeconds: 1200,
  }, { now });
  assert.match(text, /25%/);
  assert.match(text, /210\/852/);
  assert.match(text, /20 min left/);
  assert.doesNotMatch(text, /53 s/);
  ```

- [x] Run `node --test test/status.test.mjs` and confirm the missing behavior fails.
- [x] Implement the formatter using `#` and `-` for a ten-cell bar; keep
  unknown totals as phase text. Report actual chunk counts/remaining seconds
  from `buildVectors`, byte counts from downloads, and repository counts from
  issue retrieval. Keep index age for idle status and progress for active work.
- [x] Delete `refreshCost`; use two fitted footer lines to keep the mode hint
  visible. Run status tests and existing window/foreground-index tests.

## Task 2: Default-off vector mode and Shift+Tab

**Files:** Modify `bin/ghqcd.mjs`, `test/cli.test.mjs`; add focused integration coverage in `test/window.test.mjs`.

**Interfaces:** Internal `--serve-toggle-vectors <socket>` sends
`{ toggleVectors: true }`. Window state controls `meaningWorker()` and each
child's `GHQCD_SEMANTIC`. Worker query functions expose `.close()` to settle
pending queries and terminate the worker. `startIndexer(si, semantic)` returns
the child so only this window's semantic run can be stopped.

- [x] Add a regression that unsets `GHQCD_SEMANTIC`, runs `--index` with a
  local README fixture, and asserts success with no `models` or `runtime`
  directory. Add a socket-client test:

  ```js
  const r = await runAsync(['--serve-toggle-vectors', socket], {});
  assert.equal(r.status, 0);
  assert.deepEqual(got, { toggleVectors: true });
  ```

- [x] Run the new tests and confirm they fail before implementation.
- [x] Change the launch default to `process.env.GHQCD_SEMANTIC === '1'`.
  Add the socket action and bind Shift+Tab with `execute-silent` + `reload`
  for live fzf; use `--expect=shift-tab` in the legacy path. Preserve the query.
- [x] Lazily create the worker on the first enabled query; close and clear it
  when disabled. Keep callbacks for already running queries from emitting
  vector results once mode changes.
- [x] Pass explicit mode to index children, queue a vector refresh if enabling
  during a text-only run, and cancel only an owned vector child when disabling.
  Await its exit before allowing a replacement to contend for `index.lock`.
  Finish cancellation with a nonfailed receipt while retaining the cache.
- [x] Run focused CLI/window tests. Adjust the existing interrupt test to
  explicitly opt in, since it is testing the runtime install path.

## Task 3: E2E, documentation, review and PR

**Files:** Modify `README.md`, `CLAUDE.md`, `.claude/skills/ghqcd/SKILL.md`;
add `test/window.test.mjs` PTY coverage and update this plan's checkboxes.

- [x] Add real-fzf PTY tests with temporary `ghq`/`gh` fixtures. Send the
  Shift+Tab bytes `\x1b[Z`; assert mode changes and the typed query survives.
  Exercise a local fake vector runtime for resource lifecycle and cache reuse
  without downloading a model. Exercise ctrl-r and active phase progress.
- [x] Verify a 60-column window and a wide window. Assert the mode shortcut
  remains visible, selection is valid, and Esc exits 130 without errors.
- [x] Update usage text and current invariants to explain default-off mode,
  model/vector cache retention, progress/age, explicit environment opt-in and
  Ctrl-R behavior. Remove obsolete default-on and historical-cost descriptions.
- [x] Run `npm test`, `npm pack --dry-run`, and `git diff --check`.
- [x] Review the whole diff and callers using ponytail-review and Superpowers
  requesting-code-review; fix concrete findings and rerun affected checks.
- [x] Commit on `feat/refresh-status-vector-toggle`, push only that branch,
  and create a PR against main with the gh-pr-body file workflow. Verify the
  published PR title/body/head and report test evidence plus any limits.

## Verification record

- Clean container: Node 24 on Debian Bookworm, fzf 0.74.2, expect, zsh and fish.
  No host cache, tokens, or model directories are mounted. Test execution uses
  `--network none`; the full suite passes **108/108**, with **zero skips**.
- Five real-fzf PTY E2E cases cover query-preserving ON/OFF/ON, cache reuse,
  worker disposal, 60-column progress, owned indexer cancellation + ctrl-r,
  legacy-fzf deferred vector work at 150 columns, and crash retry suppression.
- GitHub and model inference use deterministic local fixtures. These tests
  verify application lifecycle and interaction, not model quality or a real
  1.2 GB model download.
- Regression-first checks reproduced the old default-on behavior, missing
  toggle/progress, shared-lock contention and legacy deferred-update failures.
- Self-review and independent Superpowers review found two lifecycle issues;
  both are fixed and their regressions pass. No concrete findings remain.
- `npm pack --dry-run --json` includes `lib/status.mjs` and excludes tests,
  design documents and agent instructions. `git diff --check` passes.

Reproduce the clean-container run from the repository root:

```sh
docker build -f test/container/Dockerfile -t ghqcd-e2e .
docker run --rm --network none ghqcd-e2e
```

The simple footer formatter does not retain an extra previous-index timestamp:
active progress replaces age, and idle status reads the existing `textAt`.

Delivered as PR #4: https://github.com/ryoshin0830/ghqcd/pull/4
