#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { setPriority } from 'node:os';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { ago, indexStatus } from '../lib/status.mjs';

// Read from package.json rather than a hand-maintained constant: `npm version`
// only bumps the manifest, so a literal here silently drifts and `--version`
// then reports a build the user isn't running.
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const SCHEMA_VERSION = 1;
const PKG = 'ghqcd';
const SELF = fileURLToPath(import.meta.url);

const HELP = `${PKG} ${VERSION} — pick a ghq repository with fzf and cd into it.

USAGE
  ${PKG} [options] [<query>]
  eval "$(command ${PKG} --init zsh)"   # then \`${PKG}\` moves the shell itself

OPTIONS
  --init <shell>     print shell integration for zsh | bash | fish, then exit
  --cmd <name>       function name emitted by --init (default: ${PKG})
  --query <q>        initial query (same as the positional argument)
  --list             print every cloned repository (with a query: the clones
                     --json would pick from, best first)
  --index            refresh the search index now (the window also does it
                     by itself, in the background, once a day)
  --json             stdout = 1-line JSON, never opens the fzf UI
  --quiet            stdout = path only (this is what the shell function uses)
  --no-color         disable ANSI colors (also respects NO_COLOR env)
  -h, --help         show this help
  -V, --version      show version

EXAMPLES
  ${PKG}                        search every repository: cloned, and on GitHub
  ${PKG} alchemy                lands at once on a unique match, else searches
  ${PKG} --list                 every repository path, one per line
  ${PKG} --json alchemy         machine-readable best match
  ${PKG} --quiet alchemy        path only — \`cd "$(${PKG} --quiet alchemy)"\`
  ${PKG} "把长网址缩短"           Shift+Tab also searches by meaning, any language

THE SEARCH WINDOW
  One window searches the repositories you have cloned and the ones you can
  reach on GitHub (and GitHub Enterprise hosts ghq knows): by name first, then
  description, README, issues, meaning (any language) and code. Enter goes to
  the repository, cloning it first if needed; ctrl-o opens it on GitHub;
  ctrl-r refreshes the index; Shift+Tab toggles vector search (off by default).
  The bar shows when the index was updated, or progress and time remaining.

  The index lives under ${'$'}XDG_CACHE_HOME/ghqcd (default ~/.cache/ghqcd),
  readable only by you. It holds README and issue text read through the
  GitHub API (GH_TOKEN / GITHUB_TOKEN, or \`gh auth token\`), and for meaning
  search a pinned WebAssembly runtime and model (Qwen3-Embedding-0.6B fp16,
  about 1.2 GB, downloaded once), which holds about 4 GB of memory while enabled.
  Disabling releases that memory and keeps the model and vectors for reuse.
  GHQCD_SEMANTIC=1 opts in at launch or when running --index.
  Code queries for repositories that are not cloned go to GitHub's code search.

WHY --init
  A child process cannot change its parent shell's directory, so \`npx ${PKG}\`
  alone can only *print* where to go. \`--init\` emits a shell function that
  captures that path and runs \`cd\` inside your shell. Without it, ${PKG} falls
  back to showing a copyable \`cd "…"\` command.

OUTPUT
  Default mode prints the fzf UI on the terminal and a box with the cd command
  to stderr, then waits for one key:
    c / C        copy 'cd "<path>"' to clipboard
    any other    exit silently
    Ctrl-C       exit 130

  --json mode prints 1 line of JSON to stdout:
    {"schemaVersion":1,"path":"…","slug":"…","root":"…","matches":1}
  with --list:
    {"schemaVersion":1,"count":2,"root":"…","repos":[{"path":"…","slug":"…"}]}

  On error in --json mode, stdout is empty and stderr gets:
    {"schemaVersion":1,"error":{"code":"E_NO_MATCH","message":"…"},"exitCode":2}

EXIT CODES
  0    success
  1    validation / generic failure (E_VALIDATION, E_GHQ, E_INDEX)
  2    no repository matched (E_NO_MATCH)
  3    non-interactive and the query was ambiguous or absent (E_AMBIGUOUS)
  127  ghq or fzf not installed (E_DEPS)
  130  interrupted — Esc or Ctrl-C in fzf (E_INTERRUPTED)
`;

// ── arg parsing ──────────────────────────────────────────────────────────────

// Detect --json early so even parseArgs / uncaughtException failures can
// produce a schema-compliant JSON error on stderr.
const rawJson = process.argv.slice(2).includes('--json');

function emitEarlyError(message, code = 'E_VALIDATION', exitCode = 1) {
  if (rawJson) {
    process.stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code, message },
      exitCode,
    }) + '\n');
  } else {
    process.stderr.write(`${PKG}: ${message}\n`);
    process.stderr.write(`run \`${PKG} --help\` for usage.\n`);
  }
  process.exit(exitCode);
}

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    options: {
      init: { type: 'string' },
      cmd: { type: 'string' },
      query: { type: 'string' },
      list: { type: 'boolean' },
      index: { type: 'boolean' },
      // fzf's reload and preview commands: clients of the window's query server.
      'serve-query': { type: 'string' },
      'serve-preview': { type: 'string' },
      'serve-refresh': { type: 'string' }, // fzf's ctrl-r: refresh without closing the window
      'serve-toggle-vectors': { type: 'string' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    },
    allowPositionals: true,
  }));
} catch (err) {
  emitEarlyError(err.message);
}

const serve = values['serve-query'] ?? values['serve-preview'] ?? values['serve-refresh'] ?? values['serve-toggle-vectors'];
if (serve != null) {
  const { queryClient } = await import('../lib/serve.mjs');
  await queryClient(serve, values['serve-query'] != null ? { q: positionals.join(' ') }
    : values['serve-preview'] != null ? { preview: positionals[0] ?? '', meta: positionals[1] ?? '', q: positionals.slice(2).join(' ') }
    : values['serve-refresh'] != null ? { refresh: true } : { toggleVectors: true });
  process.exit(0);
}

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`${PKG} ${VERSION}\n`);
  process.exit(0);
}

// ── color helpers ────────────────────────────────────────────────────────────

const noColorEnv =
  process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const useColor =
  !noColorEnv && !values['no-color'] && process.stderr.isTTY;
const ansi = (code) =>
  useColor ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => String(s);
const dim = ansi(2);
const cyan = ansi(36);
const magenta = ansi(35);
const yellow = ansi(33);
const green = ansi(32);
const red = ansi(31);
const bold = ansi(1);

// ── output helpers ───────────────────────────────────────────────────────────

const isJson = !!values.json;
const isQuiet = !!values.quiet;
const isPretty = !isJson && !isQuiet;

const stderr = process.stderr;
const log = (s) => {
  if (isJson || isQuiet) return;
  stderr.write(s + '\n');
};

// ── error reporting ──────────────────────────────────────────────────────────

const EXIT = {
  E_VALIDATION: 1,
  E_GHQ: 1,
  E_FZF: 1,
  E_NO_MATCH: 2,
  E_AMBIGUOUS: 3,
  E_INDEX: 1,
  E_DEPS: 127,
  E_INTERRUPTED: 130,
};

function die(code, message) {
  const exitCode = EXIT[code] ?? 1;
  if (isJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code, message },
      exitCode,
    }) + '\n');
  } else if (code !== 'E_INTERRUPTED') {
    // Cancelling the picker is the single most common way this program ends.
    // It is not an error worth a red line above the user's next prompt.
    stderr.write(`${red(`${PKG}:`)} ${message}\n`);
  }
  process.exit(exitCode);
}

// ── shell integration (--init) ───────────────────────────────────────────────

const SHELLS = ['zsh', 'bash', 'fish'];

// Single-quote for POSIX shells: close, escape, reopen.
const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
// fish single-quotes only treat \ and ' as special.
const fishq = (s) => `'${String(s).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

// The emitted function resolves the binary in three steps, in this order:
//
//   1. `${PKG}` on PATH — a global install (`npm i -g ${PKG}`). Fastest, and
//      the only one that picks up upgrades.
//   2. the absolute path of the script that generated this snippet. Covers
//      `eval "$(npx -y ${PKG} --init zsh)"` for as long as that file survives.
//   3. `npx -y ${PKG}@<version>` — always correct, ~1s per call.
//
// Step 2 matters because npx caches under ~/.npm/_npx/<hash>/ and npm may
// garbage-collect it; step 3 is what keeps the shell working when it does.
// The lookup is PATH-only (`whence -p` / `type -P` / `command -s`) — the
// function usually shares its name with the binary, so a function-aware
// lookup would find the function and recurse forever.
function shellInit(shell, fnName) {
  const desc = 'Pick a ghq repository with fzf and cd into it';
  const v = `${PKG}@${VERSION}`;
  const slug = fnName.replaceAll(/[^A-Za-z0-9_]/g, '_');

  if (shell === 'zsh') {
    return `# ${PKG} ${VERSION} — zsh integration
# Add to ~/.zshrc:  eval "$(command ${PKG} --init zsh)"

__${slug}_fallback=${shq(SELF)}

__${slug}_exec() {
  local __bin
  __bin=$(whence -p ${PKG} 2>/dev/null)
  if [[ -n $__bin ]]; then
    "$__bin" "$@"
  elif [[ -x $__${slug}_fallback ]]; then
    "$__${slug}_fallback" "$@"
  else
    npx -y ${shq(v)} "$@"
  fi
}

# ${desc}.
${fnName}() {
  emulate -L zsh
  # These print to stdout for the caller — help text, a list, JSON — and one of
  # them, --json, would collide with the --quiet added below. Capturing that and
  # handing it to cd produced "file name too long" on --help. Pass them through.
  local __a
  for __a in "$@"; do
    case $__a in
      -h|--help|-V|--version|--init|--init=*|--list|--json)
        __${slug}_exec "$@"
        return $?
        ;;
    esac
  done
  local __dir
  __dir=$(__${slug}_exec --quiet "$@") || return $?
  [[ -n $__dir ]] || return 0
  builtin cd -- "$__dir"
}
`;
  }

  if (shell === 'bash') {
    return `# ${PKG} ${VERSION} — bash integration
# Add to ~/.bashrc:  eval "$(command ${PKG} --init bash)"

__${slug}_fallback=${shq(SELF)}

__${slug}_exec() {
  local __bin
  __bin=$(type -P ${PKG} 2>/dev/null)
  if [ -n "$__bin" ]; then
    "$__bin" "$@"
  elif [ -x "$__${slug}_fallback" ]; then
    "$__${slug}_fallback" "$@"
  else
    npx -y ${shq(v)} "$@"
  fi
}

# ${desc}.
${fnName}() {
  # These print to stdout for the caller — help text, a list, JSON — and one of
  # them, --json, would collide with the --quiet added below. Capturing that and
  # handing it to cd produced "file name too long" on --help. Pass them through.
  local __a
  for __a in "$@"; do
    case "$__a" in
      -h|--help|-V|--version|--init|--init=*|--list|--json)
        __${slug}_exec "$@"
        return $?
        ;;
    esac
  done
  local __dir
  __dir=$(__${slug}_exec --quiet "$@") || return $?
  [ -n "$__dir" ] || return 0
  cd -- "$__dir"
}
`;
  }

  if (shell === 'fish') {
    return `# ${PKG} ${VERSION} — fish integration
# Add to ~/.config/fish/config.fish:  command ${PKG} --init fish | source

set -g __${slug}_fallback ${fishq(SELF)}

function __${slug}_exec
    set -l __bin (command -s ${PKG})
    if test -n "$__bin"
        $__bin $argv
    else if test -x "$__${slug}_fallback"
        $__${slug}_fallback $argv
    else
        npx -y ${fishq(v)} $argv
    end
end

function ${fnName} --description ${fishq(desc)}
    # Help text, a list or JSON goes to the caller, not to cd. --json would also
    # collide with the --quiet added below.
    for __a in $argv
        switch $__a
            case -h --help -V --version --init '--init=*' --list --json
                __${slug}_exec $argv
                return $status
        end
    end
    set -l __dir (__${slug}_exec --quiet $argv)
    # \`set\` reports the command substitution's status, but not every fish
    # release agrees on that. Capturing it keeps a failed pick from cd'ing,
    # and the empty-string guard below is correct either way.
    set -l __st $status
    if test $__st -ne 0
        return $__st
    end
    if test -z "$__dir"
        return 0
    end
    cd -- $__dir
end
`;
  }

  return null;
}

if (values.init != null) {
  const shell = values.init;
  if (!SHELLS.includes(shell)) {
    emitEarlyError(`--init expects one of ${SHELLS.join(' | ')}, got '${shell}'`);
  }
  const fnName = values.cmd ?? PKG;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(fnName)) {
    emitEarlyError(`--cmd must be a valid shell function name, got '${fnName}'`);
  }
  process.stdout.write(shellInit(shell, fnName));
  process.exit(0);
}

// ── argument validation ──────────────────────────────────────────────────────

if (values.json && values.quiet) {
  die('E_VALIDATION', '--json and --quiet are mutually exclusive');
}
if (values.cmd != null) {
  die('E_VALIDATION', '--cmd is only meaningful together with --init');
}
if (positionals.length > 1) {
  die('E_VALIDATION', `unexpected extra arguments: ${positionals.slice(1).join(' ')}`);
}
if (values.query != null && positionals.length > 0 && values.query !== positionals[0]) {
  die('E_VALIDATION', `--query (${values.query}) conflicts with positional (${positionals[0]})`);
}

const query = values.query ?? positionals[0] ?? '';

if (values.index && (query || values.list)) {
  die('E_VALIDATION', '--index takes no query and only combines with --json');
}

// ── interactivity ────────────────────────────────────────────────────────────

const stdinTTY = !!process.stdin.isTTY;
const stderrTTY = !!process.stderr.isTTY;
// fzf draws its UI on /dev/tty, so a piped stdout (which is the normal case —
// the shell function captures it) does not stop it. What does stop it is
// having no terminal at all, and --json, whose contract is one line and no UI.
const anyTTY = stdinTTY || stderrTTY || !!process.stdout.isTTY;
const isNonInteractive = isJson || !anyTTY;

// ── tool checks ──────────────────────────────────────────────────────────────

function commandExists(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !(r.error && r.error.code === 'ENOENT');
}

const INSTALL = {
  // git is not called directly, but `ghq list -p` shells out to it and fails
  // with exit 1 and an empty listing when it is absent. Checking for it here
  // turns that into a message that names the missing tool.
  git: { brew: 'git', url: 'https://git-scm.com/downloads' },
  ghq: { brew: 'ghq', url: 'https://github.com/x-motemen/ghq#installation' },
  fzf: { brew: 'fzf', url: 'https://github.com/junegunn/fzf#installation' },
};

function brewAvailable() {
  return spawnSync('brew', ['--version'], { stdio: 'ignore' }).status === 0;
}

async function ensureTool(cmd) {
  if (commandExists(cmd)) return;
  const { brew, url } = INSTALL[cmd];
  if (isNonInteractive || !stdinTTY || !stderrTTY) {
    die('E_DEPS', `'${cmd}' not found in PATH. Install it with \`brew install ${brew}\` — ${url}`);
  }
  const ok = await confirmYesNo(`'${cmd}' not found. Install via 'brew install ${brew}'?`);
  if (!ok) die('E_DEPS', `Aborted. See ${url}`);
  if (!brewAvailable()) {
    die('E_DEPS', `Homebrew unavailable. See ${url}`);
  }
  const r = spawnSync('brew', ['install', brew], { stdio: ['inherit', 2, 'inherit'] });
  if (r.status !== 0) die('E_DEPS', `brew install ${brew} failed`);
}

// ── raw-mode keypress (no dependency on a prompt library) ────────────────────

let rawModeEngaged = false;
function disengageRawMode() {
  if (rawModeEngaged && process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
  rawModeEngaged = false;
}
function restoreCursor() {
  if (process.stderr.isTTY) {
    try { process.stderr.write('\x1b[?25h'); } catch { /* ignore */ }
  }
}

process.on('exit', () => { disengageRawMode(); restoreCursor(); });
for (const sig of ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { disengageRawMode(); restoreCursor(); process.exit(130); });
}
process.on('uncaughtException', (err) => {
  disengageRawMode(); restoreCursor();
  if (rawJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code: 'E_VALIDATION', message: String(err?.message ?? err) },
      exitCode: 1,
    }) + '\n');
  } else {
    stderr.write(`${red(`${PKG}:`)} ${err?.stack ?? err}\n`);
  }
  process.exit(1);
});

async function waitForKey() {
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('keypress');
  try {
    process.stdin.setRawMode(true);
    rawModeEngaged = true;
  } catch { /* setRawMode throws on non-TTY; let the keypress fall through */ }
  process.stdin.resume();
  try {
    return await new Promise((resolve) => {
      const handler = (buf) => {
        process.stdin.removeListener('data', handler);
        resolve(buf);
      };
      process.stdin.on('data', handler);
    });
  } finally {
    disengageRawMode();
    process.stdin.pause();
  }
}

async function confirmYesNo(question) {
  stderr.write(`${question} ${dim('[Y/n]')} `);
  const buf = await waitForKey();
  stderr.write('\n');
  if (buf.includes(0x03)) process.exit(130);
  const c = buf[0];
  return c === 0x0d || c === 0x0a || c === 0x79 || c === 0x59; // Enter, y, Y
}

// ── candidate collection ─────────────────────────────────────────────────────

// ghq supports several roots at once (`ghq.root` repeated, or a colon-separated
// GHQ_ROOT). `ghq root` prints only the first, so a slug derived from it is
// wrong for every repository living under a secondary root — it degraded to the
// full path. Ask for all of them, longest first so a nested root wins.
function ghqRoots() {
  const all = spawnSync('ghq', ['root', '--all'], { encoding: 'utf8' });
  const list = all.status === 0
    ? (all.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    : [];
  if (list.length) return list.sort((a, b) => b.length - a.length);
  const one = spawnSync('ghq', ['root'], { encoding: 'utf8' });
  const first = one.status === 0 ? (one.stdout ?? '').trim().split('\n')[0] : '';
  return first ? [first] : [];
}

function listRepos() {
  const r = spawnSync('ghq', ['list', '-p'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    die('E_GHQ', `\`ghq list -p\` failed: ${(r.stderr ?? '').trim() || `exit ${r.status}`}`);
  }
  return (r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

// ── fzf ──────────────────────────────────────────────────────────────────────

// Non-interactive scoring pass. `fzf --filter` prints ranked matches and never
// opens a UI, so the same fuzzy semantics apply with or without a terminal.
function fzfFilter(candidates, q) {
  const r = spawnSync('fzf', ['--filter', q], {
    input: candidates.join('\n') + '\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.error) die('E_FZF', `could not run fzf: ${r.error.message}`);
  return (r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

// ── width / box ──────────────────────────────────────────────────────────────

// Rough East Asian Width: 全角 CJK + 全角ラテン + half-symbols treated as wide.
// Good enough for box layouts; bail to one-line fallback when uncertain.
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x20) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||
    (cp >= 0x2E80 && cp <= 0x303E) ||
    (cp >= 0x3041 && cp <= 0x33FF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0xA000 && cp <= 0xA4CF) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE30 && cp <= 0xFE4F) ||
    (cp >= 0xFF00 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x1F300 && cp <= 0x1FAFF)
  ) return 2;
  return 1;
}
function strWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

function renderBox(cdCommand) {
  const cols = process.stdout.columns || process.stderr.columns || 80;
  const inner = strWidth(cdCommand) + 4;
  if (inner + 2 > cols - 2) return `${dim('next:')} ${cyan(cdCommand)}`;
  const titleRaw = ' next ';
  const titleW = strWidth(titleRaw);
  const top = `╭─${titleRaw}${'─'.repeat(Math.max(0, inner - titleW - 1))}╮`;
  const empty = `│${' '.repeat(inner)}│`;
  const bot = `╰${'─'.repeat(inner)}╯`;
  const pad = ' '.repeat(Math.max(0, inner - strWidth(cdCommand) - 2));
  return [
    dim(top),
    dim(empty),
    dim('│  ') + cyan(cdCommand) + dim(pad + '│'),
    dim(empty),
    dim(bot),
  ].join('\n');
}

// ── clipboard ────────────────────────────────────────────────────────────────

function hasCmd(c) {
  return spawnSync(c, ['--version'], { stdio: 'ignore' }).error?.code !== 'ENOENT'
    || spawnSync('which', [c], { stdio: 'ignore' }).status === 0;
}
function clipboardCommand() {
  if (process.platform === 'darwin') return { bin: 'pbcopy', args: [] };
  if (process.env.WAYLAND_DISPLAY && hasCmd('wl-copy')) return { bin: 'wl-copy', args: [] };
  if (process.env.DISPLAY && hasCmd('xclip')) {
    return { bin: 'xclip', args: ['-selection', 'clipboard'] };
  }
  return null;
}
function copyToClipboard(text) {
  // OSC 52 for tmux / SSH — best-effort, doesn't error
  if (process.env.SSH_CONNECTION || process.env.TMUX) {
    try {
      stderr.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
    } catch { /* ignore */ }
  }
  const cmd = clipboardCommand();
  if (!cmd) {
    stderr.write(dim('clipboard tool not found, copy manually\n'));
    return false;
  }
  const r = spawnSync(cmd.bin, cmd.args, { input: text });
  if (r.status !== 0) {
    stderr.write(dim(`${cmd.bin} failed, copy manually\n`));
    return false;
  }
  return true;
}

// ── search index (--index and the window) ────────────────────────────────────

// Loaded on demand so the plain picker never pays for it.
const searchIndex = () => import('../lib/search-index.mjs');
const pathOf = (line) => line.split('\t')[0];

// Output for --index (foreground, or the window's background run). All of it goes to stderr,
// even under --quiet: the shell function adds that flag to every call.
// On a terminal, progress is one line rewritten in place and the run ends in a
// one-line receipt, so a refresh leaves one line of scrollback, not ten.
// Anywhere else (a log, a screen reader) lines are appended, at most every 2 s.
let liveLine = false;
let lastAppend = 0;
function fit(s, width) {
  if (strWidth(s) <= width) return s;
  let out = '';
  for (const ch of s) {
    if (strWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}
function say(s) {
  if (liveLine) stderr.write('\r\x1b[2K');
  liveLine = false;
  stderr.write(`${s}\n`);
}
function progress(s) {
  if (stderr.isTTY) {
    stderr.write(`\r\x1b[2K${dim(fit(s, (stderr.columns || 80) - 1))}`);
    liveLine = true;
  } else if (Date.now() - lastAppend > 2000) {
    lastAppend = Date.now();
    say(s);
  }
}

// Throws; the caller decides whether a failure ends the program.
async function refreshIndex(si, repos, slugOf, semantic, { verbose = false } = {}) {
  const t0 = Date.now();
  const s = si.readStatus();
  // The window's status bar reads this, at most twice a second.
  let wrote = 0, hinted = !verbose;
  const report = (text, details = {}) => {
    // Said once, and only to someone who can press ctrl-c: not to the window,
    // whose indexer runs on in the background.
    if (!hinted && text.startsWith('embedding') && / min left/.test(text)) { hinted = true; say(dim('ctrl-c stops; the next run resumes where it stopped')); }
    progress(text);
    if (Date.now() - wrote > 500) {
      wrote = Date.now();
      si.writeProgress({ text, since: t0, ...details });
    }
  };
  const at = semantic ? s.semanticAt : s.textAt;
  if (verbose) say(dim(`indexing ${repos.length} repositories${at ? ` · last updated ${ago(at)}` : ''}`));
  if (!verbose) progress(`indexing ${repos.length} repositories…`);
  const release = si.lockIndex();
  try {
    const { index, stats } = await si.buildTextIndex(repos.map((p) => ({ path: p, slug: slugOf(p) })), { progress: report });
    const res = { ...stats };
    // tokenFor() sends it to GH_HOST only, so without GH_HOST it goes nowhere.
    const ignored = (process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN) && !process.env.GH_HOST
      && 'GH_ENTERPRISE_TOKEN is ignored without GH_HOST: export GH_HOST=<your GHE host>';
    if (verbose) {
      say(dim(`  ${stats.readmes} READMEs, ${stats.github} repositories on GitHub, ${stats.issues} issues` +
        (stats.skipped ? `, ${stats.skipped} skipped (no token for the host, not on GitHub, or no access)` : '')));
      if (!stats.github && stats.skipped) say(dim('  for issues: set GH_TOKEN, or log in with `gh auth login`'));
      if (ignored) say(dim(`  ${ignored}`));
    }
    if (stats.errors) {
      say(`${PKG}: warning: GitHub could not be read for ${stats.errors} repositories; their last issues are kept (first: ${stats.firstError})`);
    }
    if (semantic) Object.assign(res, await si.buildVectors(index, { log: (m) => { say(dim(m)); report(m); }, progress: report }));
    const took = si.duration((Date.now() - t0) / 1000);
    const receipt = `indexed ${repos.length + stats.remote} repositories in ${took}` +
      (semantic ? ` · ${res.changed} ${res.changed === 1 ? 'README or issue' : 'READMEs or issues'} changed` : ` · ${stats.issues} issues`);
    say(`${green('✓')} ${receipt}`);
    const failed = !stats.github && stats.errors > 0;
    si.writeProgress({
      // A host that could not be read is named beside the receipt, not instead of it.
      done: true, failed, text: failed ? `GitHub could not be read: ${stats.firstError}` : `${receipt}${stats.errors ? ` · not read: ${stats.firstError}` : ''}`,
      // The window's footer is the only place a background run can say this.
      ...((!stats.github && stats.skipped && { hint: 'no GitHub token: run gh auth login, then ctrl-r' }) || (ignored && { hint: ignored })),
    });
    return res;
  } catch (err) {
    si.writeProgress({ done: true, failed: true, text: err.message });
    throw err;
  } finally {
    if (liveLine) stderr.write('\r\x1b[2K'); // a failure's message starts on a clean line
    liveLine = false;
    release();
  }
}

async function runIndex(repos, slugOf) {
  const si = await searchIndex();
  const t0 = Date.now();
  let res;
  try {
    res = await refreshIndex(si, repos, slugOf, SEMANTIC, { verbose: true });
  } catch (err) {
    die(err.code?.startsWith?.('E_') ? err.code : 'E_INDEX', err.message); // ENOENT is no code of ours (I7)
  }
  res.seconds = Math.round((Date.now() - t0) / 1000);
  res.cache = si.cacheDir();
  if (isJson) process.stdout.write(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...res }) + '\n');
  else say(dim(`  cache: ${res.cache}`));
}

// Opt in at launch, or with Shift+Tab in the window. Cached models/vectors stay.
const SEMANTIC = process.env.GHQCD_SEMANTIC === '1';

// The window refreshes the index once a day, in the background. --json and
// --list never do, so there an old index is pointed out instead.
const STALE_DAYS = 7;
function staleHint(at, cmd) {
  const days = (Date.now() - at) / 864e5;
  if (at && days > STALE_DAYS) say(dim(`${PKG}: the index is ${Math.floor(days)} days old; \`${cmd}\` refreshes it`));
}

// ── the search window ────────────────────────────────────────────────────────
// One fzf window over every repository you can reach, cloned or not. fzf runs
// with --disabled: the ranking is ours (lib/rank.mjs), served from this process
// over a socket (lib/serve.mjs) so the index and the model stay in memory.

const CLIENT = `${shq(process.execPath)} ${shq(SELF)}`;

// fzf with --footer and a Unix-socket --listen can show live progress; older
// fzf (Debian's 0.38) gets the status once, as a header. Probed rather than
// parsed from --version: fzf exits 2 at once on an option it does not know.
function liveFzf(dir) {
  if (process.platform === 'win32') return false;
  const probe = join(dir, `probe-${process.pid}.sock`);
  const ok = spawnSync('fzf', ['--filter=x', '--footer=x', `--listen=${probe}`], { input: 'x\n', stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;
  rmSync(probe, { force: true });
  return ok;
}

// The index refreshes itself: a detached, low-priority `ghqcd --index` that
// outlives the window if it has to and reports through progress.json. The
// lock in --index keeps it to one at a time. Its first report comes only once
// GitHub has answered (5-10 s for a page of READMEs), so the bar says
// "starting" at once: ctrl-r used to look like it did nothing.
function startIndexer(si, semantic) {
  const child = spawn(process.execPath, [SELF, '--index'], {
    detached: true, stdio: 'ignore', env: { ...process.env, GHQCD_SEMANTIC: semantic ? '1' : '0' },
  });
  try { setPriority(child.pid, 19); } catch { /* not allowed here: run at normal priority */ }
  child.unref();
  si.writeProgress({ pid: child.pid, since: Date.now(), text: 'starting' });
  return child;
}
const running = (si) => {
  const p = si.readProgress();
  const pid = si.indexPid();
  // A contender's "starting" can race the lock holder's next progress report.
  if (pid && (p?.pid !== pid || p.done)) return { pid, text: 'updating index' };
  return p && !p.done && si.alive(p.pid) ? p : null;
};
const stale = (si, semantic) => si.needsRefresh(si.readStatus(), si.readProgress(), Date.now(), semantic);

// The status bar: what the index is doing, else how old it is and the keys.
function statusLine(si, semantic) {
  const p = si.readProgress();
  // The bar sits under the list: half the width while the preview shows.
  const cols = stderr.columns || 80;
  const width = (cols >= 100 ? Math.floor(cols / 2) : cols) - 4;
  const head = indexStatus(si.readStatus(), running(si) || (p?.done ? p : null));
  const state = semantic ? 'ON (enabled)' : 'OFF (disabled)';
  const action = semantic ? 'disable' : 'enable';
  return [head, `vectors: ${state} · shift-tab: ${action} · ctrl-r refresh · enter go · ctrl-o GitHub`]
    .map((line) => fit(line, width)).join('\n');
}

let matchLabel, matchContext, LABELS, flat; // from lib/rank.mjs, loaded with the window

// Bold the query's words in a line, unless color is off.
function mark(text, terms) {
  if (!useColor || !terms.length) return text;
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  return text.replace(re, (m) => `\x1b[1m${m}\x1b[22m`);
}

// One result line after the key: `<meta>\t<shown text>`. meta is
// `<label>|<#issue or file:line>|<similarity>`, for ctrl-o and the preview; fzf
// shows only the text. The text starts with a label column saying what matched
// (lib/rank.mjs matchLabel): the words, in cyan; `~`, by meaning, in magenta;
// code, in yellow. The label is the signal; color only repeats it.
const LABEL_WIDTH = 7;
function display(hit, terms) {
  const label = matchLabel(hit);
  const tint = hit.via === 'meaning' ? magenta : hit.via === 'code' ? yellow : cyan;
  const ref = hit.loc ?? (hit.number ? `#${hit.number}` : '');
  // Found by its name or path: the description is shown, dim, as context only.
  const text = LABELS[label]?.byName ? dim(flat(hit.description))
    : mark(flat(`${hit.via === 'meaning' && hit.number ? `#${hit.number} ` : ''}${hit.snippet ?? hit.description ?? ''}`), terms);
  const score = hit.via === 'meaning' ? hit.score?.toFixed(2) : '';
  return `${label}|${ref}|${score ?? ''}\t${tint(label.padEnd(LABEL_WIDTH))} ${hit.slug}${hit.cloned ? '' : dim(' · not cloned')}  ${text}`;
}

// No query yet: everything, clones first, then the most recently pushed.
const browse = (docs) => [...docs]
  .sort((a, b) => b.cloned - a.cloned || (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
  .map((d) => `${d.key}\t||\t${' '.repeat(LABEL_WIDTH)} ${d.slug}${d.cloned ? '' : dim(' · not cloned')}  ${dim(flat(d.description))}`);

// The right pane: what matched and how, then the matched lines in place.
function preview(docs, key, meta, q) {
  const d = docs.find((x) => x.key === key);
  if (!d) return [];
  const [label = '', ref = '', score = ''] = meta.split('|');
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [bold(d.slug) + (d.cloned ? '' : dim('  not cloned: enter clones it'))];
  const what = label.endsWith('issue') ? `issue ${ref}` : label === 'code' ? `code in ${ref}` : LABELS[label.replace(/^~/, '')]?.what;
  const how = label.startsWith('~') ? `by meaning${score ? ` (similarity ${score})` : ''}` : 'by the words typed';
  if (what) out.push(`${dim('matched')} ${what} ${dim(how)}`, '');
  const passage = (text, head) => {
    const at = matchContext(text, terms);
    return (at.length ? at : String(text ?? '').split('\n').slice(0, head)).map((l) => mark(l, terms));
  };
  const issue = ref.startsWith('#') && d.issues?.find((i) => i.number === Number(ref.slice(1)));
  if (issue) out.push(bold(`#${issue.number} ${issue.title}`), ...passage(issue.body, 12));
  else if (label === 'code' && d.cloned) {
    const [file] = ref.split(':');
    const grep = spawnSync('git', ['-C', d.key, 'grep', '-h', '-n', '-i', '-F', '-C', '3', '-e', q, '--', file], { encoding: 'utf8' });
    out.push(...(grep.stdout ?? '').split('\n--\n')[0].split('\n').map((l) => mark(l, terms)));
  } else if (label === 'code') out.push(dim('ctrl-o opens the file on GitHub'));
  else if (label.endsWith('readme') && d.readme) out.push(...passage(d.readme, 12));
  if (d.description && label !== 'desc') out.push('', flat(d.description));
  else if (label === 'desc') out.push(mark(flat(d.description), terms));
  if (d.cloned) {
    const log = spawnSync('git', ['-C', d.key, 'log', '--oneline', '-5'], { encoding: 'utf8' }).stdout?.trim();
    if (log) out.push('', dim('recent commits'), log);
  }
  return out;
}

function openUrl(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => say(url));
  child.unref();
}
function urlOf(doc, meta) {
  const base = `https://${doc.slug}`;
  const [, ref = ''] = meta.split('|');
  if (ref.startsWith('#')) return `${base}/issues/${ref.slice(1)}`;
  const [file, line] = ref.split(':');
  return file ? `${base}/blob/HEAD/${file}${line ? `#L${line}` : ''}` : base;
}

function clone(slug) {
  say(dim(`cloning ${slug}…`));
  // ghq and git talk on stderr; stdout stays ours (I1).
  const r = spawnSync('ghq', ['get', `https://${slug}`], { stdio: ['ignore', 2, 2] });
  if (r.signal === 'SIGINT') die('E_INTERRUPTED', 'cancelled');
  if (r.status !== 0) die('E_GHQ', `ghq get failed for https://${slug}`);
  const path = spawnSync('ghq', ['list', '-e', '-p', slug], { encoding: 'utf8' }).stdout?.trim().split('\n')[0];
  if (!path) die('E_GHQ', `ghq get reported success, but no clone of ${slug} can be found`);
  say(`${green('✓')} cloned ${slug}`);
  return path;
}

async function searchWindow(si, repos, slugOf) {
  const { startServer, streamResults, socketPath, socketDir } = await import('../lib/serve.mjs');
  const cache = si.privateDir(si.cacheDir());
  const dir = socketDir(cache);
  let docs = si.readDocs(repos, slugOf);
  let seen = JSON.stringify(si.readStatus());
  let semantic = SEMANTIC;
  let worker;
  const meaning = async (q, signal) => {
    if (!semantic) return [];
    const active = worker ??= meaningWorker();
    const hits = await active(q, signal);
    return semantic && worker === active ? hits : [];
  };
  let ownIndexer;
  const startRefresh = () => {
    if (running(si) || ownIndexer) return;
    const child = startIndexer(si, semantic);
    ownIndexer = { child, semantic };
    child.once('exit', (code, signal) => {
      if (ownIndexer?.child !== child) return;
      const cancelled = ownIndexer.cancelled;
      ownIndexer = null;
      if (cancelled && si.readProgress()?.pid === child.pid) {
        si.writeProgress({ pid: child.pid, done: true, text: 'vector update paused; progress saved' });
      } else if ((code || signal) && !si.indexPid()) {
        const p = si.readProgress();
        if (p?.pid === child.pid && !p.done) {
          si.writeProgress({ pid: child.pid, done: true, failed: true, text: `indexer stopped (${signal || `exit ${code}`})` });
        }
      }
    });
  };
  const toggleVectors = () => {
    semantic = !semantic;
    if (!semantic) {
      worker?.close();
      worker = undefined;
      if (ownIndexer?.semantic && !ownIndexer.cancelled) {
        ownIndexer.cancelled = true;
        try {
          // Include a synchronous npm install's children, so shutdown can finish.
          if (process.platform === 'win32') ownIndexer.child.kill('SIGTERM');
          else process.kill(-ownIndexer.child.pid, 'SIGTERM');
        } catch { /* it already finished */ }
      }
    } else if (stale(si, semantic)) startRefresh();
  };
  const { codeSearch } = await import('../lib/code.mjs');
  const tokens = new Map();
  const token = (host) => (tokens.has(host) ? tokens.get(host) : tokens.set(host, si.tokenFor(host)).get(host));
  // Every answer starts with one header line (fzf --header-lines=1): fzf keeps
  // the old list until a line arrives, so a query with no name hits used to
  // leave the previous results up for seconds while meaning and code ran.
  const stream = (q, write, signal) => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {
      write(`\t||\t${dim('every repository, clones first · type to search')}`);
      return browse(docs).forEach(write);
    }
    // A legend for the label column, and what is still on its way.
    write(`\t||\t${dim(`“${q}” · ${Object.keys(LABELS).join(' ')} code: the words typed${semantic ? ' · ~: by meaning, follows' : ''}`)}`);
    return streamResults({
      query: q, docs, signal, emit: (h) => write(`${h.key}\t${display(h, terms)}`),
      code: (qq, sig) => codeSearch({ docs, query: qq, signal: sig, token }),
      meaning,
    });
  };
  const server = await startServer(socketPath(dir), async (p, write, signal) => {
    // ctrl-r: the bar picks the run up on its next tick, within 0.5 s.
    if (p.refresh) return void startRefresh();
    if (p.toggleVectors) return void toggleVectors();
    if (p.preview != null) return preview(docs, p.preview, p.meta ?? '', p.q ?? '').forEach(write);
    return stream(String(p.q ?? ''), write, signal);
  });
  const socket = socketPath(dir);
  if (stale(si, semantic)) startRefresh();
  const live = liveFzf(dir);
  const fzfSock = join(dir, `fzf-${process.pid}.sock`);
  // A Ctrl-C during the clone after the window must still clean up. Only
  // here: elsewhere (npm ci, brew) the child would die first and be reported
  // as a failure before this handler ran.
  process.on('SIGINT', () => process.exit(130));
  // On every way out, Esc included (die() exits at once): sockets go, and a
  // background index run is mentioned so a first 1.2 GB download is not a secret.
  process.on('exit', () => {
    server.close();
    worker?.close();
    rmSync(fzfSock, { force: true });
    if (dir !== cache) rmSync(dir, { recursive: true, force: true });
    const p = running(si);
    if (p) stderr.write(`${dim(`${PKG}: indexing continues in the background (${p.text}); the next window shows its progress`)}\n`);
  });
  // An index run that finished since the list was last read: search the new index.
  const fresh = () => {
    const s = JSON.stringify(si.readStatus());
    if (s === seen) return false;
    seen = s;
    docs = si.readDocs(repos, slugOf);
    return true;
  };
  const post = (action) => {
    const req = request({ socketPath: fzfSock, method: 'POST', path: '/' });
    req.on('error', () => {});
    req.end(action);
  };
  let typed = query;
  for (;;) {
    fresh();
    const status = statusLine(si, semantic);
    const args = [
      '--height=40%', '--layout=reverse', '--border', '--prompt=repo> ',
      '--disabled', '--ansi', '--no-sort', '--delimiter=\t', '--with-nth=3..', '--no-hscroll',
      '--print-query', `--query=${typed}`,
      // `--`: a query such as `--init` is a query, not an option.
      `--bind=change:reload:${CLIENT} --serve-query ${shq(socket)} -- {q}`,
      `--preview=${CLIENT} --serve-preview ${shq(socket)} -- {1} {2} {q}`,
      '--preview-window=right,50%,wrap,border-left,<50(hidden)', '--min-height=14', '--header-lines=1',
      // A live fzf refreshes in place; an old one closes, refreshes here and reopens.
      ...(live ? ['--expect=ctrl-o', `--bind=ctrl-r:execute-silent:${CLIENT} --serve-refresh ${shq(socket)}`,
        `--bind=shift-tab:execute-silent(${CLIENT} --serve-toggle-vectors ${shq(socket)})+reload(${CLIENT} --serve-query ${shq(socket)} -- {q})`,
        `--footer=${status}`, `--listen=${fzfSock}`]
        : ['--expect=ctrl-o,ctrl-r,shift-tab', `--header=${status}`]),
    ];
    // fzf runs reload and preview with $SHELL; those commands are POSIX sh,
    // which a login shell like nu or pwsh is not.
    const fzf = spawn('fzf', args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, SHELL: '/bin/sh' } });
    const ac = new AbortController();
    fzf.stdin.on('error', () => ac.abort());
    // The first list streams in exactly like a reload.
    Promise.resolve(stream(typed, (l) => fzf.stdin.write(`${l}\n`), ac.signal)).finally(() => fzf.stdin.end());
    let shown = status;
    const tick = setInterval(() => {
      // Enabling during a text refresh catches up as soon as its lock is free.
      if (semantic && stale(si, semantic)) startRefresh();
      const changed = fresh();
      if (!live) return;
      const now = statusLine(si, semantic);
      if (now !== shown) post(`change-footer:${(shown = now)}`);
      if (changed) post(`reload:${CLIENT} --serve-query ${shq(socket)} -- {q}`);
    }, 500);
    let out = '';
    fzf.stdout.on('data', (d) => { out += d; });
    const [code, signal] = await new Promise((r) => fzf.on('close', (c, s) => r([c, s])));
    clearInterval(tick);
    ac.abort();
    if (code === 130 || signal === 'SIGINT') die('E_INTERRUPTED', 'cancelled');
    // fzf exits 1 on an empty list but still reports the key: ctrl-r there is
    // exactly "I just made it, find it".
    const [q = '', key = '', line = ''] = out.replace(/\n$/, '').split('\n');
    const [k, meta = ''] = line.split('\t');
    const doc = docs.find((d) => d.key === k);
    typed = q;
    if ((code === 0 || code === 1) && key === 'shift-tab') { toggleVectors(); continue; }
    if ((code === 0 || code === 1) && key === 'ctrl-r') {
      if (running(si)) continue;
      // Old fzf cannot show a background run, so refresh here, then reopen.
      try { await refreshIndex(si, repos, slugOf, semantic); } catch (err) { say(`${red(`${PKG}:`)} refresh failed: ${err.message}`); }
      continue;
    }
    if ((code === 0 || code === 1) && key === 'ctrl-o') { if (doc) openUrl(urlOf(doc, meta)); continue; }
    if (code === 1) die('E_NO_MATCH', 'no repository selected');
    if (code !== 0) die('E_FZF', `fzf exited with status ${code}`);
    if (!doc) die('E_NO_MATCH', 'no repository selected');
    return doc;
  }
}

// The window's meaning search: on a worker thread, 250 ms after typing stops,
// and only for the query still on screen.
function meaningWorker() {
  const worker = new Worker(new URL('../lib/meaning-worker.mjs', import.meta.url), { workerData: { env: process.env } });
  worker.unref();
  const waiting = new Map();
  let n = 0;
  worker.on('message', ({ id, hits }) => { waiting.get(id)?.(hits); waiting.delete(id); });
  // A worker that died answers nothing: every later query gets no meaning
  // hits at once, so the code hits held behind them still show.
  let dead = false;
  const gone = () => { dead = true; for (const done of waiting.values()) done([]); waiting.clear(); };
  worker.on('error', gone);
  worker.on('exit', gone);
  const query = async (q, signal) => {
    const { afterPause } = await import('../lib/serve.mjs');
    if (dead || q.trim().length < 2 || !(await afterPause(250, signal))) return [];
    const id = ++n;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      signal.addEventListener('abort', () => { waiting.delete(id); resolve([]); }, { once: true });
      worker.postMessage({ id, query: q });
    });
  };
  query.close = () => { gone(); worker.terminate(); };
  return query;
}

// ── main flow ────────────────────────────────────────────────────────────────

async function main() {
  await ensureTool('git');
  await ensureTool('ghq');
  if (!values.index) await ensureTool('fzf');

  const roots = ghqRoots();
  const root = roots[roots.length - 1] ?? ''; // the primary, for the `root` field
  const slugOf = (p) => {
    for (const r of roots) if (p.startsWith(`${r}/`)) return p.slice(r.length + 1);
    return p;
  };

  const repos = listRepos();
  // With no clone, --index and the window still reach GitHub: a new machine
  // finds its repositories there and clones one with Enter.
  if (values.index) return runIndex(repos, slugOf);
  if (repos.length === 0 && (values.list || isNonInteractive)) {
    die('E_NO_MATCH', 'ghq has no repositories. Clone one with `ghq get <url>` first.');
  }

  const si = await searchIndex();
  const rank = await import('../lib/rank.mjs');
  ({ matchLabel, matchContext, LABELS, flat } = rank);
  const docs = query ? si.readDocs(repos, slugOf) : [];
  // No word matched anywhere (`alweb`, `ali/web`): match the clone paths the
  // way fzf did before the index existed, so those queries still land. A
  // subsequence of a name not cloned is no word: 2,000 org names have `alweb`.
  const fuzzy = () => (rank.keywordRank(docs, query, { limit: Infinity }).some((h) => h.cloned || h.field !== 'fuzzy')
    ? [] : fzfFilter(repos, query));
  // What --json picks from and --list shows: clones only, so `path` exists
  // (I7), and ranked alone so hundreds of org repositories cannot crowd them out.
  const clonesFor = () => {
    const hits = rank.keywordRank(docs.filter((d) => d.cloned), query, { limit: Infinity });
    return hits.length ? hits : fuzzy().map((key) => ({ key }));
  };

  // ── --list ────────────────────────────────────────────────────────────────
  if (values.list) {
    const shown = query ? clonesFor().map((h) => h.key) : repos;
    if (shown.length === 0) die('E_NO_MATCH', `no repository matched '${query}'`);
    if (isJson) {
      process.stdout.write(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        count: shown.length,
        root,
        repos: shown.map((p) => ({ path: p, slug: slugOf(p) })),
      }) + '\n');
    } else {
      process.stdout.write(shown.join('\n') + '\n');
    }
    return;
  }

  // ── pick one ──────────────────────────────────────────────────────────────
  let selected;
  let matches;
  let extra = {};
  if (isNonInteractive && !query) {
    die('E_AMBIGUOUS',
      'no terminal for the fzf UI. Pass a query to pick non-interactively, ' +
      'or use --list to see every candidate.');
  }
  if (isNonInteractive) {
    const hits = clonesFor();
    if (hits.length === 0) {
      const [far] = rank.keywordRank(docs.filter((d) => !d.cloned), query, { limit: 1 });
      die('E_NO_MATCH', far
        ? `no clone matched '${query}'; ${far.slug} is on GitHub: ghq get https://${far.slug}`
        : `no repository matched '${query}'`);
    }
    if (si.readTextIndex()) staleHint(si.readStatus().textAt, `${PKG} --index`);
    // Best first. `matches` travels in the payload so a caller can notice the
    // choice was not unique.
    selected = hits[0].key;
    matches = hits.length;
    if (hits[0].field === 'issue') extra = { issue: hits[0].number };
  } else {
    const fuzzyOne = () => {
      const [only, ...more] = fuzzy();
      return only && !more.length ? docs.find((d) => d.key === only) : null;
    };
    const doc = (query && (rank.landing(docs, query) ?? fuzzyOne())) || await searchWindow(si, repos, slugOf);
    selected = doc.cloned ? doc.key : clone(doc.slug);
    matches = 1;
  }

  // ── output ────────────────────────────────────────────────────────────────
  if (isJson) {
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      path: selected,
      slug: slugOf(selected),
      root,
      matches,
      ...extra,
    }) + '\n');
    return;
  }
  if (isQuiet) {
    process.stdout.write(selected + '\n');
    return;
  }

  // Pretty mode is the `npx ${PKG}` path: no shell function is in play, so the
  // best we can do is hand over a cd command the user can paste or copy.
  const cdCommand = `cd "${selected}"`;
  stderr.write('\n');
  stderr.write(renderBox(cdCommand) + '\n');
  stderr.write(
    `   ${dim('tip:')} ${dim(`eval "$(command ${PKG} --init zsh)"`)} ${dim('lets')} ` +
    `${bold(PKG)} ${dim('cd for you')}\n`,
  );

  if (!stdinTTY || !stderrTTY) return;
  stderr.write(`   ${dim('press')} ${bold('c')} ${dim('to copy')} ${dim('·')} ${dim('any other key to exit')}\n`);
  const buf = await waitForKey();
  if (buf.includes(0x03)) process.exit(130);
  if (buf[0] === 99 || buf[0] === 67) {
    if (copyToClipboard(cdCommand)) stderr.write(`   ${green('✓')} ${dim('copied')}\n`);
  }
}

main().then(() => {
  // The WebAssembly runtime keeps worker threads alive after the last query or
  // index run; exit once stdout has drained.
  process.stdout.write('', () => process.exit(process.exitCode ?? 0));
}).catch((err) => {
  disengageRawMode();
  restoreCursor();
  if (isJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code: 'E_VALIDATION', message: String(err?.message ?? err) },
      exitCode: 1,
    }) + '\n');
  } else {
    stderr.write(`${red(`${PKG}:`)} ${err?.stack ?? err}\n`);
  }
  process.exit(1);
});
