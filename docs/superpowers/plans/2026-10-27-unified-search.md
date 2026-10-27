# Unified search window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ghqcd [query]` opens one fzf window that ranks cloned and not-yet-cloned GitHub/GHE repositories together by name > description > README > issues > code, adds meaning matches below, and clones on Enter when needed.

**Architecture:** A pure ranker (`lib/rank.mjs`) scores repository documents. The parent `ghqcd` keeps the index in memory and answers queries on a Unix socket (`lib/serve.mjs`); fzf runs with `--disabled` and `change:reload` into a tiny `ghqcd --serve-query` client that streams the parent's lines, so keyword hits appear at once and meaning / code hits are appended as they arrive.

**Tech Stack:** Node ≥ 20.12 (no new dependencies), fzf ≥ 0.38, ghq, git, GitHub GraphQL + REST code search, the existing onnxruntime-web runtime in the cache.

**Spec:** `docs/superpowers/specs/2026-10-27-unified-search-design.md`

## Global Constraints

- Zero runtime dependencies (I9); no install scripts; `npm install --ignore-scripts` works.
- stdout is for the selected path / JSON only (I1); fzf never inherits our stdout (I4); cancel is silent exit 130 (I6).
- `--json` returns only cloned repositories; `path` always exists (I7). Adding fields is fine.
- fzf flags used must exist in fzf 0.38: `--disabled`, `--bind change:reload(...)`, `--expect`, `--print-query`, `--ansi`, `--with-nth`, `--delimiter`, `--no-sort`, `--header`, `--preview-window ...,<N(hidden)`.
- No `fzf --listen` (0.38 has no API key).
- Weights (points): name exact 100, name prefix 90, name substring 80, slug substring 60, name subsequence (single-term queries only) 40, description 30, README 20, issue title 12, issue body 8. Ties: cloned first, then newer `pushedAt`.
- Meaning hits: cosine ≥ 0.35, at most 20, only repositories without a keyword hit. Code hits last.
- Tests: no network, no TTY; the ranker is unit-tested as a pure function.
- `--issues` is removed; `--semantic` stays only as an `--index` option (opts in to the model).
- Fast path: exactly one cloned hit on name/slug/fuzzy → go; else zero such cloned hits and exactly one not-cloned name hit (≥80/term) → clone and go; else open the window.

## Review Focus

1. A query that is a unique cloned repository name (`ghqcd api`) must still land without opening the window → test in Task 4.
2. A query whose only name match is not cloned (`ghqcd lj`) clones then lands; with `--json` it is E_NO_MATCH naming `ghq get` → tests in Task 4.
3. Typing fast: an old query's late meaning/code lines must not appear under a newer query → Task 3 test (closed connection stops output).
4. No index at all (fresh user): the window works on cloned names only and says how to add GitHub → Task 4 test (`--json` on names without index) and manual check.
5. Repositories with CJK names/descriptions and queries: matching is case-insensitive and Unicode-safe → Task 1 test with a Japanese description.

---

### Task 1: Pure ranker

**Files:**
- Create: `lib/rank.mjs`
- Test: `test/rank.test.mjs`

**Interfaces:**
- Produces:
  - `type Doc = { key: string, slug: string, name: string, cloned: boolean, pushedAt?: string, description?: string, readme?: string, issues?: {number:number,title:string,body:string}[] }`
  - `keywordRank(docs: Doc[], query: string, { limit = 200 } = {}) → Hit[]`
  - `type Hit = { key, slug, cloned, score: number, field: 'name'|'slug'|'fuzzy'|'description'|'readme'|'issue', snippet: string, number?: number }`
  - `nameHits(hits: Hit[]) → Hit[]` — hits whose every term matched the name (80–100).
  - `pathHits(hits: Hit[]) → Hit[]` — hits whose every term matched name, slug, or (single term) name subsequence: what fzf matched before.

- [ ] **Step 1: Write failing tests** in `test/rank.test.mjs`:
  - exact name beats a README mention: docs `lj` (name) and `other` (readme contains "lj") → order `[lj, other]`, `hits[0].field === 'name'`.
  - order of fields: same query found in description of A, README of B, issue title of C, issue body of D → `[A, B, C, D]`.
  - AND across terms: query `sandbox 回収` matches only the doc where both appear (in any fields).
  - case-insensitive, CJK: description `ショートURL・ファイル転送`, query `url` → hit with field `description`.
  - subsequence only for one term: `ghqzh` matches name `ghqcd-zhja-poc` (field `fuzzy`); `gq zj` matches nothing.
  - tie-break: two equal scores → cloned first, then newer `pushedAt`.
  - snippet: for a README hit, snippet contains the matched term and is ≤ 120 chars.
- [ ] **Step 2:** `node --test test/rank.test.mjs` → FAIL (module missing).
- [ ] **Step 3:** Implement `lib/rank.mjs` with the Global Constraints points; per term take the best field; score = sum; drop docs where any term has no field. Snippet = whitespace-flattened window of ~100 chars around the first matched term.
- [ ] **Step 4:** `node --test test/rank.test.mjs` → PASS.
- [ ] **Step 5:** Commit `feat: rank repositories by name > description > README > issues`.

### Task 2: Index of every reachable repository

**Files:**
- Modify: `lib/search-index.mjs` (`buildTextIndex`, `issueLines` removed, `semanticRank` keys, new `readDocs`)
- Test: `test/cli.test.mjs` (fake GraphQL answers `viewer.repositories`)

**Interfaces:**
- Consumes: Task 1 `Doc`.
- Produces:
  - `index.repos[key]` where key = absolute path when cloned, else `host/owner/name`; value `{ slug, name, cloned, pushedAt, description, readme, issues }`.
  - `readDocs(localPaths: string[], slugOf) → Doc[]` — index entries plus cloned repositories missing from the index (name only).
  - `semanticRank(query)` unchanged signature; results carry `key` (same as `path` for cloned).

- [ ] **Step 1: Failing test:** extend `fakeGitHub()` so a query containing `viewer` returns two repositories: `alice/apple` (cloned in the shims) and `alice/zebra` (not cloned, description `remote only`, README text `zebra readme`). Assert after `--index --json`: `index.json` has key `github.com/alice/zebra` with `cloned:false`, `readme:'zebra readme'`, and the cloned `apple` entry is keyed by its path (no duplicate).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** In `buildTextIndex`, per host (hosts of the cloned slugs ∪ `github.com`, minus `gist.github.com`) with a token, page `viewer.repositories(first:100, affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER])` with `nameWithOwner description viewerPermission pushedAt isArchived` and README via `object(expression:"HEAD:README.md"){... on Blob{text}}` (also `readme.md`, `README`). Keep the per-clone REPO_Q for cloned repos the viewer list lacks. Issues for writable repos (cloned or not). Missing token / API error keeps the previous entry (existing `keep()` rule).
- [ ] **Step 4:** run → PASS; existing index tests still pass.
- [ ] **Step 5:** Commit `feat: index every repository you can reach, cloned or not`.

### Task 3: Query server and streaming client

**Files:**
- Create: `lib/serve.mjs`
- Test: `test/serve.test.mjs`

**Interfaces:**
- Consumes: `keywordRank`, `semanticRank`-like `meaning(query) → Promise<{key,score,snippet,number?}[]>`, `code(query, signal) → AsyncIterable<{key, snippet}>`.
- Produces:
  - `startServer({ socket, docs, meaning, code, display(hit) → string }) → Promise<{ close() }>`; protocol: client writes one JSON line `{"q": "..."}` or `{"preview": "<key>"}`; server writes result lines `key\tdisplay\n` and closes. Keyword lines first, then meaning lines for keys not already sent, then code lines. If the client disconnects, pending work for that request is abandoned (an `AbortSignal`).
  - `queryClient(socket, payload) → Promise<void>` pipes the response to stdout (used by `ghqcd --serve-query` / `--serve-preview`).
  - `socketPath(cacheDir) → string` (`<cache>/run-<pid>.sock`; `\\.\pipe\ghqcd-<pid>` on Windows).

- [ ] **Step 1: Failing tests:** start a server with two docs and a fake `meaning` that resolves after 50 ms with one extra key and a fake `code` that yields one line after 100 ms; query `{"q":"apple"}` → lines in order keyword, meaning, code, no duplicates. Second test: client disconnects after the first line → the fake `code` sees `signal.aborted === true`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement with `node:net`; socket file in the 0700 cache dir, removed on close.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** Commit `feat: answer queries over a socket, streaming slow results after fast ones`.

### Task 4: One window in the CLI

**Files:**
- Modify: `bin/ghqcd.mjs` (parse args, main flow, picker, remove `pickWithIssues`/`pickSemantic`/`--issues`/`--semantic`, add `--serve-query`/`--serve-preview` hidden flags, clone on Enter, ctrl-o, ctrl-r, header)
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3.

- [ ] **Step 1: Failing tests:**
  - `--json apple` with an index from the fake server → path of cloned `apple`, `matches` counts all keyword hits among cloned repos.
  - `--json zebra` (only remote) → exit 2 `E_NO_MATCH`, message contains `ghq get https://github.com/alice/zebra`.
  - `--json` without any index still ranks cloned names (`banana` → banana).
  - `--issues` is rejected as an unknown option; `--semantic` without `--index` is E_VALIDATION.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement:
  - non-interactive: `keywordRank(readDocs(...), query)` filtered to `cloned`.
  - interactive: fast path per Global Constraints (`pathHits` among cloned, then `nameHits` among not cloned). Else start the server, spawn fzf asynchronously with `--disabled --ansi --no-sort --delimiter=\t --with-nth=2.. --expect=ctrl-o,ctrl-r --print-query --bind change:reload(<node> <bin> --serve-query <socket> {q}) --preview=<node> <bin> --serve-preview <socket> {1} --preview-window=right,50%,wrap,border-left,<50(hidden) --min-height=14 --header=<fitted>` and the initial query's lines on stdin.
  - Enter: key is a path → cd; else `ghq get https://<slug>` with inherited stderr, then `ghq list -e -p <slug>` → cd; print `✓ cloned <slug>`.
  - ctrl-o: open the hit's URL (`open` / `xdg-open` / `cmd /c start`), reopen with the typed query. ctrl-r: refresh (existing `refreshIndex`), reload docs, reopen.
  - line display: `slug[ · not cloned]  <snippet>`; meaning lines prefix `≈ `; code lines `code: <path>:<line> <text>`; matched terms bold unless `NO_COLOR`.
- [ ] **Step 4:** run all tests → PASS.
- [ ] **Step 5:** Commit `feat: one search window for cloned and GitHub repositories`.

### Task 5: Code hits

**Files:**
- Create: `lib/code.mjs`
- Test: `test/code.test.mjs`

**Interfaces:**
- Produces: `codeSearch({ docs, query, signal, env }) → AsyncIterable<{ key, snippet }>` — `git grep -n -I -i -F --max-count=1 -e <term>` in cloned repos (4 at a time) for queries ≥ 3 chars; for not-cloned repos with a token, one GitHub REST `search/code` request per host after the query has been unchanged for 700 ms, scoped `user:<login>`; at most 10 per minute per host.

- [ ] **Step 1: Failing test:** a temp git repo with `hello_world()` in `a.js`; `codeSearch` for `hello_world` yields `{key: <repo>, snippet: 'a.js:1 hello_world()'}`; aborted signal yields nothing.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: code hits from git grep and GitHub code search, last in the list`.

### Task 6: Docs, manual TUI verification, push

**Files:** `README.md`, `CLAUDE.md`, `.claude/skills/ghqcd/SKILL.md`, `docs/research/semantic-search-plan.md`

- [ ] Update docs (one window, keys, `--json` contract, removed flags).
- [ ] Manual (tmux) at 150 / 80x24 / 60 columns: typing streams results; `lj` (not cloned) clones and lands; ctrl-o opens; ctrl-r refreshes; Esc exits 130 silently; unique `ghqcd ghqcd-zh` lands without the window.
- [ ] `npm test`, `npm pack --dry-run` (7+ files, no `.claude/`).
- [ ] Commit, push the PR branch, post a PR comment.
