# `--search` for agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the search window does is reachable from one non-interactive command, so an agent can search clones and GitHub by name, description, README, issues, meaning and code, and see why each result matched.

**Architecture:** `ghqcd --search [<q>]` runs the window's own `streamResults` (lib/serve.mjs) once, collects the hits instead of writing fzf lines, and prints them: one JSON line with `--json`, tab-separated lines otherwise. No new search code; the window and the command share one result order.

**Tech Stack:** Node ≥ 20.12, node:test, zero runtime dependencies.

**Spec:** the conversation of 2026-10-28 (the gap table: not-cloned results, meaning, code, match labels, URL, index state are window-only today).

## Global Constraints

- I1: stdout only carries the result; warnings go to stderr.
- I7: adding fields is fine; nothing existing is removed or renamed, `schemaVersion` stays 1.
- I8b: every flag that prints to stdout passes through the shell function uncaptured — `--search` joins `--list`/`--json`.
- I9: no runtime dependency.
- I12: meaning search runs only when opted in (`GHQCD_SEMANTIC=1`); query text leaves the machine only for GitHub code search on repositories that are not cloned.
- `--search` needs no fzf and no TTY.

## Window → command map (what the docs must say)

| Window | Command |
| --- | --- |
| type a query | `ghqcd --search --json <q>` |
| label column, `#issue`/`file:line`, similarity | `match`, `ref`, `similarity` per result |
| Enter on a not-cloned line | `ghq get https://<slug> && ghq list -e -p <slug>` |
| ctrl-o | `url` per result |
| ctrl-r | `ghqcd --index` |
| status bar | `index` in the `--search` payload |
| Shift+Tab | `GHQCD_SEMANTIC=1` |

## Review Focus

- No index yet: `--search` still returns clones (keyword hits), `index.updatedAt` is null.
- `GHQCD_SEMANTIC=1` with no model downloaded: keyword and code results still come back, one warning on stderr, `semantic: false`.
- No match anywhere: exit 2 `E_NO_MATCH`, stdout empty.
- `--search` combined with `--list`, `--index` or `--quiet`: `E_VALIDATION`.
- No fzf on PATH: `--search` still works.

---

### Task 1: `streamResults` emits hits, not lines

**Files:**
- Modify: `lib/serve.mjs` (`streamResults`)
- Modify: `bin/ghqcd.mjs` (`searchWindow`'s `stream`)
- Test: `test/serve.test.mjs`

**Interfaces:**
- Produces: `streamResults({ query, docs, meaning, code, emit, signal })` — `emit(hit)` once per hit, best first; `hit.via` is `undefined` (keyword) / `'meaning'` / `'code'`. No `display`, no `write`.

- [ ] Update the serve tests to pass `emit: (h) => lines.push(\`${h.key}\t${h.slug} ${h.via ?? h.field}\`)`; same expected arrays.
- [ ] Run `node --test test/serve.test.mjs`: FAIL (emit is not called).
- [ ] Replace `display`/`write` with `emit` in `streamResults`; the window passes `emit: (h) => write(\`${h.key}\t${display(h, terms)}\`)`.
- [ ] `npm test`: PASS. Commit.

### Task 2: `ghqcd --search`

**Files:**
- Modify: `bin/ghqcd.mjs` (parseArgs, validation, `ensureTool('fzf')` guard, `main`, `shellInit` passthrough ×3, `urlOf`)
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: Task 1's `streamResults`.
- Produces (stdout, `--json`):

```json
{"schemaVersion":1,"query":"…","count":2,"root":"…","semantic":false,
 "index":{"updatedAt":"<ISO>|null","vectorsAt":"<ISO>|null","running":"<progress text>|null"},
 "results":[{"slug":"…","path":"<clone path>|null","cloned":true,"match":"desc","ref":"#12|file:line|null",
             "similarity":0.52,"snippet":"…","description":"…","url":"https://…"}]}
```

`match` is `matchLabel(hit)`; `similarity` only on meaning hits; `url` is `urlOf` (issue → `/issues/N`, code → `/blob/HEAD/file#Lline`). No query: every doc in the window's browse order with `match: null`. Text mode: one line per result, `match\tslug\tpath-or-empty\tref\tsnippet`.

- [ ] Tests (with an `index.json` fixture holding one clone with an issue and one not-cloned repo): `--search --json <issue word>` returns the issue hit with `match:'issue'`, `ref:'#N'`, `url` ending `/issues/N`; a word only the not-cloned repo has returns `cloned:false`, `path:null`; no-match exits 2 with empty stdout; `--search --list` exits 1 `E_VALIDATION`; `--search` works with fzf removed from PATH; `GHQCD_SEMANTIC=1` without a model still answers with `semantic:false`; the zsh/bash/fish functions pass `--search` through.
- [ ] Run them: FAIL.
- [ ] Implement. Meaning: `si.meaningSearch()` when `SEMANTIC`, errors → one stderr line, `semantic:false`. Code: `codeSearch` with `si.tokenFor`.
- [ ] `npm test`: PASS. Commit.

### Task 3: Docs

**Files:** `bin/ghqcd.mjs` (HELP), `README.md` ("For scripts and AI agents"), `.claude/skills/ghqcd/SKILL.md`, `CLAUDE.md` (I7 schema, I8b flag list).

- [ ] Help lists `--search`; README and SKILL.md carry the window → command map above; SKILL.md drops "meaning and code search exist only in the window".
- [ ] `npm test`: PASS (help tests). Commit.
