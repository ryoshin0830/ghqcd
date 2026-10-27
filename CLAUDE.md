# CLAUDE.md

Guidance for any AI agent (Claude Code, Codex, opencode, etc.) that works
**inside** this repository.

This file is for **maintainers of `ghqcd`**. To USE ghqcd from an agent session,
see `.claude/skills/ghqcd/SKILL.md` and the "For scripts and AI agents" section
of `README.md` instead.

---

## What this package does

A small Node.js CLI (zero runtime dependencies) that:

1. Runs `ghq list -p` for every cloned repository, and `ghq root` for slugs.
2. Picks one — interactively in one fzf search window over every repository
   you can reach (cloned or on GitHub, see I12), or non-interactively among
   clones (`--json`, `--quiet` without a TTY).
3. Prints the chosen path: as a `cd "…"` box (default), one bare line
   (`--quiet`), or one line of JSON (`--json`).
4. Emits a shell function on `--init <shell>` so the *shell* performs the `cd`.

Single source of behavior: `bin/ghqcd.mjs`. The search lives in `lib/`:
`rank.mjs` (keyword ranking, pure), `search-index.mjs` (index, vectors),
`serve.mjs` (the window's query server), `code.mjs` (code hits) — see I12.

Sibling packages built to the same contract: `gwqcd`, `gwqpull`, `ghnew`.

---

## Invariants (do not break)

### I1. stdout / stderr discipline

- **stdout** is for machine-readable output **only**: the `--quiet` path, the
  `--json` payload, the `--list` lines, the `--init` shell snippet, and the
  `--help`/`--version` body.
- **stderr** is for everything else: the `cd` box, the keypress prompt, ANSI
  cursor restore, every error message.
- `ghqcd > out.txt` MUST leave the human-facing box on the terminal and
  `out.txt` empty.

This is not cosmetic. `--quiet` stdout is consumed by `$(…)` inside the
generated shell function; anything else on that stream becomes part of the
path the shell tries to `cd` into.

### I1b. git is a dependency even though it is never called directly

`ghq list -p` shells out to git and exits 1 with an empty listing without it. So `git` is checked with the others, and the user gets "install git"
instead of a puzzle. Verified by removing git from PATH; there is a test.

### I2. `--init` is a flag, not a subcommand

`ghqcd init zsh` would be ambiguous in the sibling `gwqpull`, whose positional
is a repository spec. All four tools in this family therefore spell it
`--init <shell>`. Do not "fix" this to match zoxide.

### I3. The generated function resolves its binary in three steps

`PATH` → the absolute path of the script that generated the snippet →
`npx -y ghqcd@<version>`. Each step exists for a reason:

- **PATH first** so a global install wins and picks up upgrades.
- **Baked path second** so `eval "$(npx -y ghqcd --init zsh)"` works at all.
- **npx last** because npm garbage-collects `~/.npm/_npx/<hash>/`, and without
  this step the user's shell silently loses the command.

The lookup MUST be PATH-only (`whence -p` / `type -P` / `command -s`). The
emitted function shares its name with the binary by default, so a
function-aware lookup (`command -v`, `which` in some shells) finds the function
and recurses until the shell dies.

### I4. fzf's UI does not travel on stdout

`fzf` draws on `/dev/tty` and writes only the selection to stdout. That is why
the interactive picker still works when our own stdout is a pipe — which is the
normal case, since the shell function captures it. Spawn fzf with
`stdio: ['pipe', 'pipe', 'inherit']` and never with `'inherit'` on fd 1.

### I5. `--quiet` stays interactive; `--json` does not

`--quiet` is the shell function's mode: it must still open the fzf UI. Only
`--json` — and the absence of any TTY — forces the non-interactive
`fzf --filter` path. Do not collapse the two into one "non-interactive" flag.

`isNonInteractive` gates our *own* prompts (the brew-install confirm, the
clipboard keypress), never fzf.

### I6. Cancelling is not an error

fzf exits 130 on Esc / Ctrl-C. `die('E_INTERRUPTED', …)` deliberately writes
**nothing** to stderr in non-JSON mode: cancelling the picker is the single
most common way this program ends, and a red line above the user's next prompt
every time is noise. The exit code still propagates.

### I6b. ghq can have several roots

`ghq.root` may be repeated, and `GHQ_ROOT` may be colon-separated. `ghq root`
prints only the first, so deriving a slug from it left every repository under a
secondary root with `slug` equal to its full path. `ghqRoots()` uses
`ghq root --all`, sorted longest-first so a nested root wins, and `slugOf()`
tries each. The `root` field still reports the primary.

### I7. `--json` schema (external contract)

Selection:

```json
{
  "schemaVersion": 1,
  "path":          "<absolute-local-path>",
  "slug":          "<host>/<owner>/<repo>",
  "root":          "<ghq root>",
  "matches":       <number of candidates the query matched>
}
```

Listing (`--list --json`):

```json
{
  "schemaVersion": 1,
  "count":         <number>,
  "root":          "<ghq root>",
  "repos":         [{ "path": "…", "slug": "…" }]
}
```

Error (stderr, exit ≠ 0):

```json
{ "schemaVersion": 1, "error": { "code": "E_*", "message": "…" }, "exitCode": <number> }
```

`matches` exists so a caller can detect that it got the best-scoring candidate
of several rather than a unique hit. `issue` (a number) is added when an issue,
not the name, matched. `path` is always a clone: `--json` never returns a
repository that is not cloned (E_NO_MATCH names `ghq get` instead). Adding fields is fine; removing or
renaming requires a `schemaVersion` bump.

stderr *carries* the error line; it is not exclusively JSON. Node warnings and
child diagnostics share the stream. Consumers — including our own tests — must
select the line starting with `{`, never parse the whole stream.

### I8. Exit codes

| Code | Constant        | Meaning                                          |
|------|-----------------|--------------------------------------------------|
| 0    | —               | success                                          |
| 1    | `E_VALIDATION`  | flag conflict, extra positional, parseArgs error |
| 1    | `E_GHQ`         | `ghq list -p` failed                             |
| 1    | `E_FZF`         | fzf could not be run, or exited unexpectedly     |
| 1    | `E_INDEX`       | `--index` failed, or another one is running      |
| 2    | `E_NO_MATCH`    | no repositories, or the query matched none       |
| 3    | `E_AMBIGUOUS`   | non-interactive with no query                    |
| 127  | `E_DEPS`        | `ghq`/`fzf` missing and user declined install    |
| 130  | `E_INTERRUPTED` | Esc / Ctrl-C                                     |

### I8b. The function must not capture output that is not a path

Every flag whose result goes to stdout has to be passed through uncaptured:
`-h`, `--help`, `-V`, `--version`, `--init`, `--list`, `--json`. The wrapper adds
`--quiet`, so `--json` would additionally collide with it and error out.

This shipped broken in every one of these packages and was only found by running
the emitted function rather than syntax-checking it — `zsh -n` is perfectly happy
with a function that cds into a help page. There are tests now that install the
function in zsh, bash and fish and run `--version` and `--help` through it.

### I8c. The install snippet must say `command`

The emitted function shares its name with the binary, so `eval "$(ghqcd --init
zsh)"` in `~/.zshrc` resolves to the *function* on every re-source after the
first. A stale function then captures the `--init` output and hands it to `cd`:

    gwqcd:cd:5: no such file or directory: # gwqcd 0.2.1 — zsh integration\n…

Reported by a user running `source ~/.zshrc` after an upgrade. `command` skips
functions and goes to PATH, which makes re-sourcing idempotent no matter what is
already defined. The npx form (`eval "$(npx -y ghqcd --init zsh)"`) never had the
problem, because npx is not the function.

The generated snippet's own header comment shows the `command` form too — it is
the line people copy.

### I9. Zero runtime dependencies

`ghnew` depends on `@inquirer/prompts`; this package deliberately does not.
`ghqcd` runs on the interactive hot path — every dependency is npx cold-start
latency and typosquat surface. The one prompt we need (`confirmYesNo`) is
fifteen lines over the raw-mode keypress reader we already have.

### I9b. The embedding runtime is installed, not depended on

Meaning search needs an ONNX runtime and a tokenizer. They are **not** in
`package.json`: the first `ghqcd --index` copies `lib/runtime/package.json` and
its lockfile into the cache and runs `npm ci --ignore-scripts` there, then
imports them by absolute path. So `npx ghqcd` stays dependency-free, nothing
runs an install script, and every transitive version and integrity hash is
pinned in `lib/runtime/package-lock.json`. Bump them by regenerating that
lockfile, never with a range.

The runtime is `onnxruntime-web` (WebAssembly), on purpose: `onnxruntime-node`
is about four times faster, but ships ~300 MB of per-OS binaries, has a
postinstall, and has no Intel-Mac build. Measurements are in
`docs/research/semantic-search-plan.md`.

### I10. Raw mode cleanup

`process.stdin.setRawMode(true)` is guarded by `stdin.isTTY`. Cleanup runs on
`exit`, `SIGTERM`, `SIGHUP`, `uncaughtException`, and inside `try/finally`.
Cursor restore (`\x1b[?25h`) is guarded by `stderr.isTTY` to prevent escape
bytes leaking into files.

### I12. One search window

The window (bin/ghqcd.mjs, "the search window") is the only interactive UI.

- **What it searches:** `readDocs()` — the index plus clones it has not seen.
  The index has one entry per repository: a clone is keyed by its path,
  anything else by `host/owner/name`; a clone is never listed twice, and a
  clone deleted from disk is offered for cloning again.
- **Ranking** (`lib/rank.mjs`, pure, unit-tested): every word must match; per
  word the strongest field counts. Points: name exact 100 / prefix 90 /
  substring 80, slug 60, name subsequence (one word only) 40, description 30,
  README 20, issue title 12, issue body 8. Ties: clones first, then newest
  push. The user fixed the order name > description > README > issues > code;
  do not reorder. Subsequence runs on the name only: on the slug, `cli`
  matched every repository through `github.com/alice`.
- **Below keyword hits:** meaning hits (cosine ≥ 0.45, at most 20, issue
  chunks −0.1), then code hits.
- **Every line says what matched**, in a 7-column label (`matchLabel` in
  `lib/rank.mjs`): `name`, `name*`, `path`, `desc`, `readme`, `issue`,
  `~readme`, `~issue`, `code`; `~` alone means "by meaning". ASCII only: `≈`
  is East Asian ambiguous width and shifts the column under ja locales. The
  meta field is `<label>|<#issue or file:line>|<similarity>`; the preview gets
  `{q}` and shows `matched … by …` and the matched lines (`matchContext`). `lib/serve.mjs` streams them in that
  order; fzf shows lines as they arrive.
- **Mechanics:** the parent keeps the index and the model in memory and answers
  on a Unix socket in the 0700 cache dir. fzf runs `--disabled` with
  `change:reload:<node> <bin> --serve-query <sock> {q}`; fzf kills the old
  child on the next keystroke, and the server stops that query's work when its
  client hangs up. `fzf --listen` is used only on a Unix socket (never a TCP
  port: fzf 0.38 has no API key, and any local user could make it run
  commands). The window's fzf is spawned asynchronously — the parent must keep
  answering the socket while fzf runs.
- **Meaning search runs on a worker thread** (`lib/meaning-worker.mjs`), 250 ms
  after typing stops, only for the query still on screen. ORT's `run()` and
  the model load never yield; on the main thread they held up every
  keystroke's name hits. Each answer starts with one header line
  (`--header-lines=1`): fzf keeps the old list until a line arrives.
- **Fast path:** `ghqcd <q>` lands without the window on a unique clone matched
  by name, slug or subsequence (what fzf matched on the path before) unless a
  not-cloned repository matches its name better, else — only when no clone
  matches in any field — on a unique not-cloned name match (cloned first):
  `landing()` in `lib/rank.mjs`. Keep `ghqcd api`
  landing. When no word matches any repository (`alweb`, `ali/web`),
  `fzf --filter` on the clone paths decides, as before the index: a unique
  path lands, and `--json` takes the best.
- **Clone on Enter:** `ghq get https://<slug>` with ghq's output on stderr
  (I1), then `ghq list -e -p <slug>`.
- **The index refreshes itself:** the window starts a detached, nice-19
  `ghqcd --index` when the index is missing or a day old (or vectors are), and
  never from `--json` / `--list` / no-TTY runs. `--index` writes
  `progress.json`; the window polls it every 0.5 s and updates the footer with
  `change-footer` over `--listen=<cache>/fzf-<pid>.sock`, and `reload`s when
  `status.json` changes. An fzf without `--footer` + Unix-socket `--listen`
  (probed with `fzf --filter`, 27 ms) gets the status once as a header.
- **ctrl-r never closes a live window:** it is `execute-silent` of
  `--serve-refresh <sock>`, and the parent starts the run. Whoever starts a
  run writes `progress.json` (`starting`, with `since`) at once: the run's own
  first report waits for GitHub's first page (5-10 s for 100 READMEs), and a
  bar that did not move for that long read as "ctrl-r does nothing". A
  finished run's receipt, and any host it could not read, stays in the bar
  for a minute. GraphQL 5xx is retried once (github.com 502s on heavy pages).
- **Listings:** per host, your repositories (owned / shared) with README,
  issues (writable only, 100 newest) and vectors; everything your
  organizations share with name, description and last push only (`lite`; one
  GHE host had 2,044, and READMEs for all took minutes and hours to embed).
  GraphQL calls time out after 30 s.
- **Private:** the cache holds issue text from private repositories. The
  directory is 0700 and every file 0600, written atomically. Never log issue
  text. Code queries for repositories that are not cloned go to GitHub's code
  search, scoped to the user, after 0.7 s of no typing, at most 10 a minute per
  host; that is the only query text that leaves the machine.
- **Vector search is off by default** (the user's decision). Shift+Tab toggles
  it in the current window; `GHQCD_SEMANTIC=1` explicitly opts in at launch or
  for `--index`. Disabled mode creates no search worker or vector indexing.
  Disabling releases the search worker and pauses only a vector indexer that
  this window started; cached models and completed vectors are retained.
  A text-only refresh that finishes after enabling is followed by a vector
  refresh. `needsRefresh` also catches vectors older than the text index.
- **The status bar shows age or current progress**, never the previous text
  fetch duration. `lib/status.mjs` formats phase-specific ASCII progress bars,
  counts and vector ETAs. A second footer line separates current state
  (`vectors: OFF (disabled)` / `vectors: ON (enabled)`) from the next action
  (`shift-tab: enable` / `shift-tab: disable`). Unknown totals have no invented
  percentage. Progress callbacks may pass structured `phase`, `completed`,
  `total`, `remainingSeconds` fields.
- The model is pinned by revision and SHA-256 (`MODEL` in
  `lib/search-index.mjs`). Use the **fp16** export: it matches the reference
  FP32 model exactly, while the int8 export drifted (cosine median 0.835) and
  lost about a tenth of the correct answers. Changing the model changes
  `MODEL.key`, which keys the vector files, so old vectors are never mixed in.
  Nothing deletes the old model, runtime or vectors: two installed versions
  (a global 0.2 and an npx 0.3) share one cache and would delete each other's
  1.2 GB every day. Whoever changes `MODEL` or the runtime lockfile says in the
  release notes what can be removed from `~/.cache/ghqcd`.
- One chunk per issue (title + start of body). All chunks made 12,765 chunks
  from 1,571 real issues, a 3.5-hour first pass.
- A refresh is incremental twice over: each README / issue text is hashed
  before chunking and reuses the last chunk list when unchanged; chunks are
  keyed by their own hash. The model loads only when some text changed. Bump
  `CHUNKING` when `chunk()` or its input changes.
- `buildVectors` yields to the event loop before every chunk (ORT's `run()`
  never does, so SIGTERM was ignored for hours) and saves vector keys after
  every chunk, so an interrupted run loses at most one.
- Queries load ORT with one thread: on Node 20, starting the thread pool
  sometimes spun forever inside session creation. Indexing keeps 8 threads.
- `--index` takes `index.lock` (pid inside; a dead pid's lock is taken over).
  Two runs appending to one vector file corrupted it.
- A missing or rejected token keeps what the last run fetched, per repository
  and per host; NOT_FOUND and gists are skips, not errors.
- Progress for `--index` goes to stderr even under `--quiet`. On a TTY it is
  one line rewritten in place, ended by one `✓` receipt.
- Layout was checked at 150, 80x24 and 60 columns. The preview hides below 100
  columns (fzf's `<N(hidden)` threshold is the preview's own width: `<50`).
- Timers: never pass a negative delay to `setTimeout` — Node prints a warning
  to stderr, into the window.
- Tests put a failing `gh` shim on PATH, so the developer's own login never
  reaches a test or the network.

### I11. Engines

`engines.node >= 20.12.0` for `node:util` `parseArgs` and import attributes in
the tests. Do not lower.

---

## Do NOT

- Add `preinstall` / `postinstall` scripts to `package.json` (Shai-Hulud worm
  infection vector). `npm install --ignore-scripts` must work.
- Remove `.claude/` or `CLAUDE.md` from `.npmignore`. Those files are for
  agents and maintainers, not end users; bundling them inflates the tarball and
  widens the typosquat blast radius.
- Use `console.log` for human output. Use `stderr.write(...)`. `console.log`
  goes to stdout and violates I1.
- Add a runtime dependency (see I9).
- Skip the TTY guard before `setRawMode`. It throws on non-TTY streams.
- Reintroduce a `const VERSION = '…'` literal. `npm version` only bumps the
  manifest, so a literal drifts and `--version` names a build nobody is running.

---

## Release workflow

```sh
git add -A && git commit -m "feat: …"
npm pack --dry-run          # must not contain .claude/, CLAUDE.md, test/, .git/
npm version patch           # or minor / major — commits and tags
git push --follow-tags      # pushing main fires .github/workflows/publish.yml
gh run watch                # optional; the publish happens in CI
npx -y ghqcd@latest --version
```

**Do not run `npm publish` by hand.** **Every push to main releases.** CI runs
the suite, then publishes whatever `package.json` says — raising patch itself,
and committing that bump back to main, when the version there has already
shipped. Bump manually first (`npm version minor`) to choose a number; forget,
and you still shipped at +patch. Re-run a failure with
`gh workflow run publish.yml` — there is nothing to undo and no tag to move.

Because every push releases, treat main as the publish button: docs fixes and
test tweaks land as real versions. That is deliberate.

Commit-message footgun: GitHub reads **every line** of a push's HEAD message,
not just the subject, and skips the whole event when any of them carries a CI
skip token. Never write the token in prose; say "the skip token" instead. The
bot's own releases use it legitimately, which is why they never fan out.

CI publishes with npm trusted publishing (OIDC): no npm token exists on any
laptop or in this repository's secrets, and no release needs a browser or a
passkey. One-time setup per package, on npmjs.com → the package → Settings →
Trusted Publisher: GitHub Actions, owner `ryoshin0830`, repository `ghqcd`,
workflow filename `publish.yml`, allowed action `npm publish`.

The developer machine's `.npmrc` points `registry=` at a private mirror, so
anything run locally against npmjs.org needs
`--registry=https://registry.npmjs.org`. CI has no such mirror.

---

## Testing

`npm test` runs `test/cli.test.mjs` (`node:test`, no network, no TTY) with
`ghq` and `fzf` shims on `PATH`. It covers every code path reachable without a
terminal, plus `zsh -n` / `bash -n` / `fish -n` syntax checks on the `--init`
output.

**Tests must be hermetic against the developer's own environment.** `run()`
deletes `FORCE_COLOR` from the child env because we set `NO_COLOR`, and node
warns to stderr when it sees both — which made the suite fail on a machine that
exported `FORCE_COLOR`, and only at `npm publish` time via `prepublishOnly`.
Assertions that stderr is empty go through `ourStderr()`, which strips
`(node:NNN) Warning:` lines first. Never assert on raw `r.stderr` being `''`:
stderr is a shared stream, and node's warnings are not ours to control.

The interactive fzf UI cannot be tested there. Run these by hand:

| Scenario | Command | Expect |
| --- | --- | --- |
| Interactive pick | `ghqcd` | the window opens, Enter lands the shell in the repo |
| Unique query | `ghqcd <unique>` | lands with no keystroke (fast path, I12) |
| Not cloned | type a repo you have not cloned, Enter | ` · not cloned` on its line; `ghq get` runs, `✓ cloned`, shell lands there |
| Cancel | `ghqcd`, press Esc | exit 130, shell stays put, no error line |
| Ctrl-C | `ghqcd`, press Ctrl-C | exit 130, cursor restored |
| Preview pane | `ghqcd` at ≥ 100 columns | description, README or issue, recent commits |
| Labels | type a sentence; type a function name | `~readme` / `~issue` lines, then `code` lines, below `name` / `desc` / `readme` / `issue`; preview says "matched … by …" |
| Status bar | `ghqcd`, type, ctrl-r | query and list stay; the footer shows update age or phase progress/ETA; closing says it continues |
| ctrl-o | `ghqcd`, ctrl-o | the repository (issue, file) opens in the browser; the window reopens |
| Narrow window | `ghqcd` at 80x24 and 60 columns | preview hidden, 8 result rows, footer not cut |
| npx one-shot | `npx ghqcd <q>` | box on terminal, `c` copies the cd command |
| Stdout separation | `ghqcd api > out.txt` | box on terminal, `out.txt` empty |
| No fzf | `PATH=/usr/bin ghqcd` | offers `brew install fzf`, exit 127 if declined |
| Reinstall drift | delete `~/.npm/_npx`, then `ghqcd` | still works via the npx fallback (I3) |

A pty harness (`script -q /dev/null zsh -c '…'`) can automate the `--select-1`
case, and that one is worth running after touching I3 or I4. Do **not** try to
drive the interactive fzf UI by piping keystrokes into `script` — fzf reads
`/dev/tty`, the writes do not reach it, and the harness hangs until killed.

---

## Where things live

- `bin/ghqcd.mjs` — the entire CLI (ESM, top-level await OK).
- `lib/rank.mjs` — keyword ranking (pure; I12).
- `lib/search-index.mjs` — the index, vectors, meaning search (I12).
- `lib/status.mjs` — update age, phase progress and ETA copy.
- `lib/serve.mjs` — the window's query server and result order (I12).
- `lib/code.mjs` — code hits: git grep and GitHub code search (I12).
- `lib/runtime/` — the pinned embedding runtime installed into the cache (I9b).
- `package.json` — `bin.ghqcd`, `engines.node`, `files`, `prepublishOnly`.
- `.npmignore` — defense-in-depth complement to `files`.
- `.claude/skills/ghqcd/SKILL.md` — agent USE contract. Changing it is a
  user-visible interface change; document it in the commit.
- `README.md` — end-user docs.
- `test/cli.test.mjs` — shim-based CLI tests; `test/{rank,docs,serve,code}.test.mjs` — the search parts.
- `test/window.test.mjs` — real-fzf PTY E2E with local model/GitHub fixtures;
  `test/container/Dockerfile` provides a clean Linux test environment.
- `docs/research/` — why the model, runtime and cut-offs are what they are. The
  experiment code and raw results (`poc/`) stay on the branch
  `poc/multilingual-repository-search` (PR #1).

---

## Things that are intentionally NOT here

- **A `--zoxide`-style frecency database.** `ghq list` and the index are the
  source of truth; ranking is `lib/rank.mjs` (I12).
- **Caching `ghq list` output.** It is a directory walk of a few milliseconds,
  and a stale cache after `ghq get` is worse than the walk. (The search index
  is different: it needs the network. The window still takes the clones from
  `ghq list` and merges them into the index, see `readDocs`.)
- **A prompt library, a logger, or a clipboard package.** See I9.
- **Telemetry / analytics.**
