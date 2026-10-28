---
name: ghqcd
description: >
  Resolve the absolute local path of an already-cloned ghq repository by fuzzy
  query, list every cloned repository, or search every repository the user can
  reach (cloned or on GitHub / GHE) by name, description, README, issues,
  meaning and code, with why each matched. Not for creating repos or for git
  worktrees.
when_to_use: |
  Use when the user says one of (or equivalent intent):
    - "go to the api repo / api リポジトリに移動して"
    - "where is <repo> checked out?"
    - "cd into my <name> project"
    - "list my local repos / clone してるリポ一覧"
    - "open <repo> and run the tests"
    - "which of my repos handles X? / X をやってるリポどれ？"
    - "find the repo with the issue about Y / Y の issue があるリポ"

  Do NOT use this skill when the user wants any of:
    - cloning a repository that is not on disk yet (use `ghq get`, or `gwqpull`
      when a worktree is wanted)
    - creating a brand-new remote repo (use `ghnew`)
    - a git worktree rather than the main clone (use `gwqcd`)
    - searching code inside one repository you already know (use grep/rg)
allowed-tools: Bash
---

# ghqcd — resolve a ghq repository path

`ghqcd` wraps `ghq list -p` + `fzf` and prints the selected path. With `--json`
it never opens a UI, so it is safe to call from an agent session.

## Prerequisites (verify before invoking)

1. `ghq --version`
2. `fzf --version`
3. `node --version` (must be `>= 20.12`)

If any is missing, tell the user to run `brew install ghq fzf` rather than
calling ghqcd and reporting exit 127.

## Recommended call

Always use `--json`. Never call the bare command from an agent: without a TTY
it exits 3 (`E_AMBIGUOUS`), and with one it would block on the fzf UI.

If `ghqcd` is on PATH:

```bash
ghqcd --json <query>
```

Otherwise (pin to `^0.2`, NOT `@latest`, so a future major bump does not
silently break the flow):

```bash
npx -y ghqcd@^0.2 --json <query>
```

`--json` ranks clones by where the words match: name, then description, then
README, then issues (once an index exists). When no word matches any
repository, it falls back to fzf's fuzzy match on the clone paths (`ali/web`),
as 0.1 did. So a word from what a repository *does*, or from an issue the user
remembers, also works:

```bash
ghqcd --json "upload stalls"
```

The payload adds `"issue": <number>` when an issue matched rather than the
name.

`--json` only ever returns a clone, so `path` always exists. When the best match
is a repository that is not cloned, it exits 2 (`E_NO_MATCH`) and the message
names the `ghq get https://…` command: offer to run it. It never starts an index
run; do not run `ghqcd --index` yourself unasked — it reads private repositories
and issues through the GitHub API. With `GHQCD_SEMANTIC=1`, the first vector
index also downloads a 1.2 GB model; normal text indexing does not.

## Searching: `--search --json`

When the user describes a repository instead of naming it, or wants to see
every candidate and why, use `--search`. It prints exactly what the window
would show, in the same order — clones and repositories that are not cloned,
by name, path, description, README, issues, then meaning and code:

```bash
ghqcd --search --json "upload stalls"
```

```json
{"schemaVersion":1,"query":"upload stalls","count":2,"root":"…","semantic":false,
 "index":{"updatedAt":"2026-10-28T01:00:00.000Z","vectorsAt":null,"running":null},
 "results":[{"slug":"github.com/alice/api","path":"/…/api","cloned":true,"match":"issue","ref":"#7",
             "snippet":"#7 upload stalls on big files","description":"…","url":"https://github.com/alice/api/issues/7"}]}
```

- `match` says what matched: `name`, `name*` (letters in order), `path`,
  `desc`, `readme`, `issue`, `~readme` / `~issue` (by meaning), `code`.
  Quote it to the user as the reason.
- `ref` is `#<issue>` or `<file>:<line>`; `url` opens exactly that on GitHub.
- `path` is `null` when `cloned` is false. To go there:
  `ghq get https://<slug> && ghq list -e -p <slug>` — ask first, it clones.
- Meaning search runs only with `GHQCD_SEMANTIC=1` and vectors built; check
  `semantic` in the payload. It loads a 1.2 GB model (seconds, ~4 GB memory).
- Code queries for repositories that are not cloned go to GitHub's code
  search, at most 10 a minute per host across every ghqcd run (the window's
  included); past that, GitHub code hits are simply missing for the rest of
  the minute. Clones are searched with `git grep` locally.
- `index.updatedAt: null` means no index yet: only clones, by name, path and code.
  Suggest `ghqcd --index` to the user rather than running it unasked.

Every window action has a command:

| In the window | Without it |
| --- | --- |
| type a query | `ghqcd --search --json <q>` |
| the label column | `match`, `ref`, `similarity` |
| Enter on a clone | the result's `path` |
| Enter, not cloned | `ghq get https://<slug> && ghq list -e -p <slug>` |
| ctrl-o | `url` |
| ctrl-r | `ghqcd --index` (ask first) |
| the status bar | `index` |
| Shift+Tab | `GHQCD_SEMANTIC=1` |

To enumerate instead of picking:

```bash
ghqcd --list --json
ghqcd --list --json <query>      # the clones --json <query> picks from, best first
```

## Output (stdout, 1 line)

```json
{
  "schemaVersion": 1,
  "path":          "/Users/alice/ghq/github.com/alice/api",
  "slug":          "github.com/alice/api",
  "root":          "/Users/alice/ghq",
  "matches":       1
}
```

`--list --json`:

```json
{
  "schemaVersion": 1,
  "count":         3,
  "root":          "/Users/alice/ghq",
  "repos":         [{ "path": "…", "slug": "…" }]
}
```

Parse with `jq -r .path`. Tolerate unknown fields — the schema allows additive
growth.

## `matches` is the ambiguity signal — check it

`matches > 1` means the query hit several repositories and you received the
best-scoring one. Do not silently act on it: show the user the candidates
(`ghqcd --list --json <query>` lists exactly those `matches`, best first) and
ask which they meant. Acting on a
best-guess path can run commands in the wrong repository.

`matches == 1` is unambiguous; proceed.

## Errors (stderr, 1 line JSON, non-zero exit)

```json
{ "schemaVersion": 1, "error": { "code": "E_NO_MATCH", "message": "…" }, "exitCode": 2 }
```

| code            | exit | meaning                                         |
|-----------------|------|--------------------------------------------------|
| `E_VALIDATION`  | 1    | flag conflict or extra positional                |
| `E_GHQ`         | 1    | `ghq list -p` failed                             |
| `E_FZF`         | 1    | fzf could not be run                             |
| `E_INDEX`       | 1    | `--index` failed, or another one is running      |
| `E_NO_MATCH`    | 2    | no repositories, or the query matched none       |
| `E_AMBIGUOUS`   | 3    | called without a query and without a TTY         |
| `E_DEPS`        | 127  | `ghq` or `fzf` missing                           |
| `E_INTERRUPTED` | 130  | Esc / Ctrl-C                                     |

stderr *carries* that line; it is not exclusively JSON. Node warnings and child
diagnostics share the stream, so select the line starting with `{` —
`2>&1 >/dev/null | grep -m1 '^{' | jq -r .error.code` — rather than piping the
whole stream to `jq`.

On `E_NO_MATCH`, the repository is not cloned. Say so and offer `ghq get <url>`
(or `gwqpull`); do NOT retry with a mutated query. `ghqcd --search --json <q>`
shows what did match, not cloned ones included.

## Things the skill must NOT do

- Call `ghqcd` without `--json` and try to parse the box output.
- Treat a `matches > 1` result as a confirmed choice.
- Run `ghqcd --init` to modify the user's shell config without being asked.
- Assume the returned path is a git worktree — it is the main clone. For
  worktrees use `gwqcd`.

## After success

`cd` to the returned path if the harness can change cwd; otherwise pass the
path explicitly to subsequent commands (`git -C "<path>" status`).
