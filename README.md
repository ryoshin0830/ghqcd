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
| `--query <q>` | initial query (same as the positional) |
| `--list` | print every cloned repository instead of picking one |
| `--index` | refresh the search index now (the window does it by itself, in the background) |
| `--json` | stdout = 1-line JSON, never opens the UI |
| `--quiet` | stdout = path only |
| `--no-color` | disable ANSI colors (also respects `NO_COLOR`) |
| `-h`, `--help` | show help |
| `-V`, `--version` | show version |

## One search window

`ghqcd` opens one window that searches everything at once, like a search
engine: the repositories you have cloned, your repositories on GitHub (and on
GitHub Enterprise hosts ghq knows) that are not cloned yet, and what your
organizations share.

```
╭──────────────────────────────────────────────────────────────────────╮
│ repo> url                                                            │
│   “url” · name path desc readme issue code: the words typed · ~: by… │
│ ▌ name    github.com/ryoshin0830/short-url · not cloned              │
│ ▌ desc    github.com/alice/tools  short URL and file transfer        │
│ ▌ readme  github.com/alice/web  …shorten a long URL before sharing…  │
│ ▌ issue   github.com/alice/api  #12 URL shortener returns 500        │
│ ▌ ~readme github.com/alice/links  把长网址缩短后分享                   │
│ ▌ code    github.com/alice/web  src/url.js:8 export function short…  │
│ ──────────────────────────────────────────────────────────────────── │
│   indexed 2 h ago · enter go · ctrl-o open on GitHub · ctrl-r refresh│
╰──────────────────────────────────────────────────────────────────────╯
```

The label on the left of each line says what matched, strongest first:

| Label | Matched | How |
| --- | --- | --- |
| `name` | the repository name (exact, prefix, or part of it) | the words typed |
| `name*` | the name's letters in order, as fzf matches (one word only) | the words typed |
| `path` | `host/owner/name` (an owner or host) | the words typed |
| `desc` | the description | the words typed |
| `readme` | the README | the words typed |
| `issue` | an issue's title or body | the words typed |
| `~readme` | what the name, description and README *mean* | by meaning, in any language |
| `~issue` | what an issue *means* | by meaning, in any language |
| `code` | code: `git grep` in clones, GitHub's code search otherwise | the words typed |

`~` marks a meaning (vector) match, so a Chinese query can find a Japanese
README. The labels are words, so they read the same without color
(`NO_COLOR`); color only repeats them: cyan for words, magenta for meaning,
yellow for code. The preview (at 100 columns and wider) starts with what matched
and how — `matched issue #12 by the words typed`, `matched the README by meaning
(similarity 0.56)` — followed by the matched lines in place.

Every word must match somewhere. Name hits appear as you type; meaning and code
hits are added below them as they arrive.

| Key | Does |
| --- | --- |
| type | search |
| Enter | go to the repository — `ghq get` first if it is not cloned |
| ctrl-o | open it on GitHub (the issue, or the file, when that is what matched) |
| ctrl-r | refresh the index now |
| Esc | leave (exit 130, nothing printed) |

`ghqcd <query>` still lands without the window when the match is clear: one
clone by name, or else one repository that is not cloned by name, which is
cloned first.

### The index, and the status bar

The window keeps its index fresh by itself: when the index is missing or a day
old, it starts `ghqcd --index` in the background (detached, at low priority),
and the bar at the bottom shows what it is doing:

```
indexing in the background: embedding 412 of 1,800 · about 12 min left
```

Closing the window does not stop it; the next window shows where it got to.
An interrupted run resumes where it stopped. `ghqcd --index` does the same in
the foreground. Only one index run happens at a time.

The index reads, through the GitHub API (`GH_TOKEN` / `GITHUB_TOKEN`,
`GH_ENTERPRISE_TOKEN` for other hosts, or `gh auth token`):

- **your repositories** (owned or shared with you): description, README, and
  the 100 most recently updated issues of those you can push to;
- **what your organizations share**: name and description only (one GHE host
  had 2,044 of these).

Without a token, or when the API refuses it, each repository keeps what the last
run fetched. Everything lives in `$XDG_CACHE_HOME/ghqcd` (default
`~/.cache/ghqcd`, `%LOCALAPPDATA%\ghqcd` on Windows), readable only by you,
because it holds issue text from private repositories.

### Meaning search: what gets installed

Meaning search is on by default. Nothing is added to ghqcd's own dependencies;
the first index run installs, into the cache directory:

- **runtime** — `onnxruntime-web` and `@huggingface/tokenizers`, at the exact
  versions in [`lib/runtime/package-lock.json`](lib/runtime/package-lock.json),
  via `npm ci --ignore-scripts`. It is WebAssembly, so it runs the same on
  macOS, Linux and Windows with no native build and no other app.
- **model** — [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)
  as fp16 ONNX (about 1.2 GB, once), from a pinned revision of
  [onnx-community/Qwen3-Embedding-0.6B-ONNX](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX),
  checked against SHA-256 hashes in the source.

`GHQCD_SEMANTIC=0` leaves both out. The first embedding pass is the slow part:
55 repositories with 1,571 issues made 1,796 chunks and took 37 minutes on an
Apple M4 Pro. Later runs compare each README and issue with the last run by
SHA-256 and embed only what changed; with nothing changed, a refresh takes as
long as asking GitHub (a few seconds). Searching runs on your machine, except
code queries for repositories that are not cloned, which go to GitHub's code
search (after a short pause in typing, at most 10 a minute).

Why this model, and why fp16 rather than a smaller int8 file, is measured in
[`docs/research/semantic-search-plan.md`](docs/research/semantic-search-plan.md).

## For scripts and AI agents

`--json` never opens a UI, so it is safe in a pipeline or an agent session. It
ranks the same way as the window but only ever returns a clone, so `path`
always exists; when only a repository that is not cloned matched, it exits 2
with the `ghq get` command in the message. It never starts an index run.

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
| 1 | `E_INDEX` | `ghqcd --index` failed, or another one is running |
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
