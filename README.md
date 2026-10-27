# ghqcd

Pick a [ghq](https://github.com/x-motemen/ghq) repository with [fzf](https://github.com/junegunn/fzf) and `cd` into it.

```console
$ ghqcd
  repo>
  ▌ /Users/you/ghq/github.com/you/api
    /Users/you/ghq/github.com/you/web
    /Users/you/ghq/git.example.com/team/infra
  ╭───────────────────────────────────────╮
  │ 8f2c1a9 Fix the retry budget          │
  │ 3b7d004 Bump the client               │
  ╰───────────────────────────────────────╯
$ pwd
/Users/you/ghq/github.com/you/api
```

## Install

```sh
npm install -g ghqcd
```

Then add the shell integration:

```sh
# zsh  — ~/.zshrc
eval "$(command ghqcd --init zsh)"

# bash — ~/.bashrc
eval "$(command ghqcd --init bash)"

# fish — ~/.config/fish/config.fish
command ghqcd --init fish | source
```

`command` matters: each tool defines a shell function with its own name, so on a
second `source ~/.zshrc` the *function* would answer, capture the `--init` output
and try to `cd` into it. `command` skips functions and goes to the binary.

Reload the shell and `ghqcd` moves it.

Prefer a different name? `eval "$(ghqcd --init zsh --cmd gcd)"` gives you `gcd`.

### Without installing

```sh
eval "$(npx -y ghqcd --init zsh)"
```

The emitted function resolves its binary in three steps — `ghqcd` on `PATH`,
then the script that generated the snippet, then `npx -y ghqcd@<version>` — so
it keeps working after npm garbage-collects the npx cache. It is still worth a
global install: `npx` adds about a second to every jump.

Requires `git`, `ghq` and `fzf` on `PATH` (`brew install git ghq fzf`), and
Node >= 20.12. git is needed because `ghq` shells out to it.

## Why `--init` exists

A child process cannot change its parent shell's working directory. `npx ghqcd`
therefore can only *print* where you wanted to go — which it does, in a
copyable box:

```console
$ npx ghqcd api
╭─ next ────────────────────────────────────╮
│                                           │
│  cd "/Users/you/ghq/github.com/you/api"   │
│                                           │
╰───────────────────────────────────────────╯
   press c to copy · any other key to exit
```

`--init` emits a shell *function*, and a function runs inside your shell, so it
can `cd`. This is the same mechanism [zoxide](https://github.com/ajeetdsouza/zoxide)
and [starship](https://starship.rs) use.

## Usage

```
ghqcd [options] [<query>]
```

| Option | Meaning |
| --- | --- |
| `--init <shell>` | print shell integration for `zsh` \| `bash` \| `fish` |
| `--cmd <name>` | function name emitted by `--init` (default: `ghqcd`) |
| `--query <q>` | initial fzf query (same as the positional) |
| `--list` | print every candidate instead of picking one |
| `--issues` | also search issue titles and bodies (needs `--index`) |
| `--semantic` | rank by meaning, in any language (needs `--index --semantic`) |
| `--index` | collect README, description and issues into the cache; with `--semantic`, embed them too |
| `--json` | stdout = 1-line JSON, never opens the fzf UI |
| `--quiet` | stdout = path only |
| `--no-color` | disable ANSI colors (also respects `NO_COLOR`) |
| `-h`, `--help` | show help |
| `-V`, `--version` | show version |

A query pre-filters fzf and auto-selects a unique match, so `ghqcd api` usually
lands without a keystroke.

## Searching issues, and searching by meaning

The plain picker matches repository paths. Two opt-in modes look inside:

```sh
ghqcd --index                 # README + GitHub description + issues → cache
ghqcd --issues timeout        # repositories and their issues, in fzf
ghqcd --index --semantic      # also embed everything (once; re-run to refresh)
ghqcd --semantic "把长网址缩短后分享"   # the repo whose README or issues mean that
```

- **`--index`** reads each README from your clone, and through the GitHub API
  the description and the 100 most recently updated issues of every repository
  you can push to. Issues of repositories you only read are skipped: they are
  someone else's tracker and would crowd out your own. The token comes from
  `GH_TOKEN` / `GITHUB_TOKEN` (`GH_ENTERPRISE_TOKEN` for other hosts) or
  `gh auth token`. Without one, or when the API refuses it, each repository
  keeps the description and issues of the last run.
- **`--issues`** adds one fzf line per issue (`slug  #12 title  body…`).
  Matching is exact (space-separated substrings), because fuzzy matching over a
  whole issue body matches nearly anything. Choosing an issue lands you in its
  repository; `--json` adds `"issue": 12`.
- **`--semantic`** finds a repository from a description of what it does,
  across languages: a Chinese query finds a README or issue written in
  Japanese or English. `--json` adds `"score"`: the cosine similarity of the
  best-matching chunk, minus 0.1 when that chunk is an issue.

The index lives in `$XDG_CACHE_HOME/ghqcd` (default `~/.cache/ghqcd`,
`%LOCALAPPDATA%\ghqcd` on Windows), readable only by you, because it holds
issue text from private repositories.

### What `--semantic` installs

Nothing is added to ghqcd's own dependencies, and nothing is installed until
you run `ghqcd --index --semantic`. Then, into the cache directory:

- **runtime** — `onnxruntime-web` and `@huggingface/tokenizers`, at the exact
  versions in [`lib/runtime/package-lock.json`](lib/runtime/package-lock.json),
  via `npm ci --ignore-scripts`. It is WebAssembly, so it runs the same on
  macOS, Linux and Windows with no native build and no other app.
- **model** — [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)
  as fp16 ONNX (about 1.2 GB), from a pinned revision of
  [onnx-community/Qwen3-Embedding-0.6B-ONNX](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX),
  checked against SHA-256 hashes in the source.

**Refreshing.** Nothing updates the index behind your back: it reads private
issues, so it runs only when you ask. In the `--issues` and `--semantic`
pickers, the header says when the index was built and roughly how long a
refresh takes, and **ctrl-r** refreshes it in place: progress stays on one
line, a `✓ indexed … in 6 s` line is left behind, and the picker reopens with
what you had typed. From a script, re-run `ghqcd --index --semantic` (or just
`--index`); `--json` runs mention an index more than 7 days old on stderr. A refresh compares each
README and issue with the last run by SHA-256 and re-embeds only the ones that
changed: with nothing changed it takes as long as fetching from GitHub (8
seconds for 55 repositories). Only one `--index` runs at a time.

The first embedding pass is the slow part. Each README is split into chunks of
up to 512 tokens; each issue contributes one chunk (its title and the start of
its body). 55 repositories with 1,571 issues made 1,796 chunks and took 37
minutes on an Apple M4 Pro. It is resumable, Ctrl-C is safe, and later runs
embed only what changed. A query runs locally and takes two to three seconds,
most of it loading the model.

Why this model, and why fp16 rather than a smaller int8 file, is measured in
[`docs/research/semantic-search-plan.md`](docs/research/semantic-search-plan.md).

## For scripts and AI agents

`--json` never opens a UI, so it is safe in a pipeline or an agent session.

```console
$ ghqcd --json api
{"schemaVersion":1,"path":"/Users/you/ghq/github.com/you/api","slug":"github.com/you/api","root":"/Users/you/ghq","matches":1}

$ ghqcd --list --json
{"schemaVersion":1,"count":3,"root":"/Users/you/ghq","repos":[{"path":"…","slug":"…"}]}
```

`matches` tells you whether the query was unique — `> 1` means the best-scoring
candidate was returned but the query was ambiguous.

Errors go to stderr as JSON, and stdout stays empty:

```console
$ ghqcd --json durian
{"schemaVersion":1,"error":{"code":"E_NO_MATCH","message":"no repository matched 'durian'"},"exitCode":2}
```

| Exit | Code | Meaning |
| --- | --- | --- |
| 0 | — | success |
| 1 | `E_VALIDATION`, `E_GHQ`, `E_FZF` | bad flags, or an upstream command failed |
| 1 | `E_INDEX` | no index yet (run `ghqcd --index`), or building it failed |
| 2 | `E_NO_MATCH` | no repository matched |
| 3 | `E_AMBIGUOUS` | non-interactive with no query — pass one, or use `--list` |
| 127 | `E_DEPS` | `ghq` or `fzf` not installed |
| 130 | `E_INTERRUPTED` | Esc or Ctrl-C in fzf |

Cancelling the picker exits 130 silently — no error line lands above your next
prompt.

## Related

- [`gwqcd`](https://github.com/ryoshin0830/gwqcd) — same idea for [gwq](https://github.com/d-kuro/gwq) worktrees
- [`gwqpull`](https://github.com/ryoshin0830/gwqpull) — clone with ghq, add a gwq worktree, and cd into it
- [`gwqadd`](https://github.com/ryoshin0830/gwqadd) — create a branch and its gwq worktree in the repo you are in
- [`ghnew`](https://github.com/ryoshin0830/ghnew) — create a GitHub repo, ghq-get it, and cd into it

## License

MIT © ryoshin0830
