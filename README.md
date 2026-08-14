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
eval "$(ghqcd --init zsh)"

# bash — ~/.bashrc
eval "$(ghqcd --init bash)"

# fish — ~/.config/fish/config.fish
ghqcd --init fish | source
```

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

Requires `ghq` and `fzf` on `PATH` (`brew install ghq fzf`), and Node >= 20.12.

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
| `--json` | stdout = 1-line JSON, never opens the fzf UI |
| `--quiet` | stdout = path only |
| `--no-color` | disable ANSI colors (also respects `NO_COLOR`) |
| `-h`, `--help` | show help |
| `-V`, `--version` | show version |

A query pre-filters fzf and auto-selects a unique match, so `ghqcd api` usually
lands without a keystroke.

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
| 2 | `E_NO_MATCH` | no repository matched |
| 3 | `E_AMBIGUOUS` | non-interactive with no query — pass one, or use `--list` |
| 127 | `E_DEPS` | `ghq` or `fzf` not installed |
| 130 | `E_INTERRUPTED` | Esc or Ctrl-C in fzf |

Cancelling the picker exits 130 silently — no error line lands above your next
prompt.

## Related

- [`gwqcd`](https://github.com/ryoshin0830/gwqcd) — same idea for [gwq](https://github.com/d-kuro/gwq) worktrees
- [`gwqpull`](https://github.com/ryoshin0830/gwqpull) — clone with ghq, add a gwq worktree, and cd into it
- [`ghnew`](https://github.com/ryoshin0830/ghnew) — create a GitHub repo, ghq-get it, and cd into it

## License

MIT © ryoshin0830
