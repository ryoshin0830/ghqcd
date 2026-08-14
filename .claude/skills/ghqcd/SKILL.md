---
name: ghqcd
description: >
  Resolve the absolute local path of an already-cloned ghq repository by fuzzy
  query, or list every cloned repository. Use this skill when you need to locate
  or move into a repo that is already on disk — not for cloning new ones,
  creating repos, or working with git worktrees.
when_to_use: |
  Use when the user says one of (or equivalent intent):
    - "go to the api repo / api リポジトリに移動して"
    - "where is <repo> checked out?"
    - "cd into my <name> project"
    - "list my local repos / clone してるリポ一覧"
    - "open <repo> and run the tests"

  Do NOT use this skill when the user wants any of:
    - cloning a repository that is not on disk yet (use `ghq get`, or `gwqget`
      when a worktree is wanted)
    - creating a brand-new remote repo (use `ghnew`)
    - a git worktree rather than the main clone (use `gwqcd`)
    - searching code inside repositories (use grep/rg)
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

Otherwise (pin to `^0.1`, NOT `@latest`, so a future major bump does not
silently break the flow):

```bash
npx -y ghqcd@^0.1 --json <query>
```

To enumerate instead of picking:

```bash
ghqcd --list --json
ghqcd --list --json <query>      # narrowed
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
(`ghqcd --list --json <query>`) and ask which they meant. Acting on a
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
| `E_NO_MATCH`    | 2    | no repositories, or the query matched none       |
| `E_AMBIGUOUS`   | 3    | called without a query and without a TTY         |
| `E_DEPS`        | 127  | `ghq` or `fzf` missing                           |
| `E_INTERRUPTED` | 130  | Esc / Ctrl-C                                     |

stderr *carries* that line; it is not exclusively JSON. Node warnings and child
diagnostics share the stream, so select the line starting with `{` —
`2>&1 >/dev/null | grep -m1 '^{' | jq -r .error.code` — rather than piping the
whole stream to `jq`.

On `E_NO_MATCH`, the repository is not cloned. Say so and offer `ghq get <url>`
(or `gwqget`); do NOT retry with a mutated query.

## Things the skill must NOT do

- Call `ghqcd` without `--json` and try to parse the box output.
- Treat a `matches > 1` result as a confirmed choice.
- Run `ghqcd --init` to modify the user's shell config without being asked.
- Assume the returned path is a git worktree — it is the main clone. For
  worktrees use `gwqcd`.

## After success

`cd` to the returned path if the harness can change cwd; otherwise pass the
path explicitly to subsequent commands (`git -C "<path>" status`).
