# Review fixes (PR #1, round 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four must-fix findings on PR #1 (review comments 4385191159, 4385191284, 4385191408, 4385191518).

**Architecture:** One guard per finding, each in the shared function every caller goes through: `tokenFor()` (token), `landing()` (auto-clone), `keep()` (index keys), and one path-fuzzy fallback in `bin/ghqcd.mjs` shared by the window's fast path and `--json`.

**Tech Stack:** Node ≥ 20.12, `node:test`, shims for `ghq` / `fzf` / `gh`.

**Spec:** the four review comments on PR #1; `docs/superpowers/specs/2026-10-27-unified-search-design.md` ("打鍵なしの移動"); CLAUDE.md I7, I12.

## Global Constraints

- Zero runtime dependencies (I9). stdout only for machine output (I1).
- `--json` `path` is always a clone (I7); E_NO_MATCH names `ghq get` when only a repository that is not cloned matches.
- `ghqcd api` keeps landing; `docs-site` (only a not-cloned name matches) keeps auto-cloning.
- Fuzzy (subsequence) ranking stays name-only (I12); the fallback is fzf on paths, only when no word matches anywhere.

## Review Focus

1. A query that matches a not-cloned repository by words must not fall back to fzf on paths (`--json zebra` still E_NO_MATCH with `ghq get`) → existing test `--json never picks a repository that is not cloned`.
2. `GH_HOST` unset with `GH_ENTERPRISE_TOKEN` set: no host gets the enterprise token → Task 1 test, first half.
3. A clone made since the last index, then a failing GitHub: description and issues survive → Task 4 test.
4. A clone matched only by description beside a unique not-cloned name match: window, no clone → Task 3 test.
5. Interactive fast path for `alweb` / `ali/web` (no TTY in tests) → manual pty check after Task 2.

---

### Task 1: GH_ENTERPRISE_TOKEN only for GH_HOST

**Files:** Modify `lib/search-index.mjs` (`tokenFor`), `test/cli.test.mjs` (fakeGitHub records `authorization`; the four `GH_ENTERPRISE_TOKEN: 'e'` envs get `GH_HOST: 'git.example.com'`), `README.md:172`.

- [ ] Test `--index sends GH_ENTERPRISE_TOKEN to GH_HOST only`: with `GH_HOST: 'ghe.example.com'` the fake server never sees `bearer e`; with `GH_HOST: 'git.example.com'` (cherry's host) it does.
- [ ] Run → FAIL (first half).
- [ ] `tokenFor`: return `GH_ENTERPRISE_TOKEN` only when `host !== 'github.com' && host === env.GH_HOST`.
- [ ] `npm test` → all pass. README: "`GH_ENTERPRISE_TOKEN` for the `GH_HOST` host".
- [ ] Commit `fix: GH_ENTERPRISE_TOKEN goes to GH_HOST only`.

### Task 2: no word matched → fzf on the paths, as before

**Files:** Modify `bin/ghqcd.mjs` (pick-one block), `test/cli.test.mjs`, CLAUDE.md I12 Fast path, spec "打鍵なしの移動".

- Shared in `bin/ghqcd.mjs`: `docs = query ? si.readDocs(repos, slugOf) : []`; `fuzzy() → string[]` = `[]` when `rank.keywordRank(docs, query, { limit: 1 })` has a hit, else `fzfFilter(repos, query)`.
- `--json`: no clone hit → `hits = fuzzy().map((key) => ({ key }))`; still none → the existing E_NO_MATCH (with the `ghq get` hint).
- Window: `rank.landing(docs, query) ?? (the one path fuzzy() returned, if exactly one)`, else the window.

- [ ] Test `--json falls back to fzf on the path when no word matches`: `--json test-root/github.com/alice/ap` → path `REPOS[0]`, exit 0.
- [ ] Run → FAIL (E_NO_MATCH).
- [ ] Implement as above.
- [ ] `npm test` → all pass. pty check: `ghqcd --quiet <owner-initials+name>` lands without the window.
- [ ] Commit `fix: queries fzf matched on the path still land`.

### Task 3: never auto-clone while a clone matches anywhere

**Files:** Modify `lib/rank.mjs` (`landing`), `test/rank.test.mjs`, CLAUDE.md I12 Fast path.

- [ ] Add to the landing test: `landing([doc('api', { description: 'Billing API' }), far('billing')], 'billing') === null`; `docs-site` case still lands on the far doc.
- [ ] Run → FAIL.
- [ ] `landing`: keep the full clone ranking; the far branch requires it to be empty (not just its path hits).
- [ ] `npm test` → pass. Commit `fix: no clone behind the user's back while a clone matches`.

### Task 4: keep last run's text for a clone made since then

**Files:** Modify `lib/search-index.mjs` (`buildTextIndex`: `keep`, issues catch), `test/cli.test.mjs` (`runAsync` takes shim options).

- [ ] Test `--index keeps what it knew about a repository cloned since the last run`: index with default shims (zebra not cloned) → shims with `${ROOT}/github.com/alice/zebra` added, `server.fail = true`, `--index` → `index.json` entry for that path has description `remote only` and issue #2.
- [ ] Run → FAIL.
- [ ] `old(key) = prev[key] ?? prevBySlug.get(out[key]?.slug)`; `keep` and the issues catch use it.
- [ ] `npm test` → pass. Commit `fix: a fresh clone keeps its description and issues when GitHub is unreachable`.

### Task 5: release prep and push

- [ ] `npm version minor --no-git-tag-version` (0.1.6 → 0.2.0; CI publishes the number on merge, no tag needed). SKILL.md `^0.1` → `^0.2`.
- [ ] `npm test`, `npm pack --dry-run` (no `.claude/`, `CLAUDE.md`, `test/`).
- [ ] Commit, `git push`. Reply in each review thread with the fix commit.
