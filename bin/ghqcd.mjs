#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  --query <q>        initial fzf query (same as the positional argument)
  --list             print every candidate instead of picking one
  --json             stdout = 1-line JSON, never opens the fzf UI
  --quiet            stdout = path only (this is what the shell function uses)
  --no-color         disable ANSI colors (also respects NO_COLOR env)
  -h, --help         show this help
  -V, --version      show version

EXAMPLES
  ${PKG}                        fzf over every ghq repository
  ${PKG} alchemy                fzf pre-filtered; auto-picks a unique match
  ${PKG} --list                 every repository path, one per line
  ${PKG} --json alchemy         machine-readable best match
  ${PKG} --quiet alchemy        path only — \`cd "$(${PKG} --quiet alchemy)"\`

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
  1    validation / generic failure (E_VALIDATION, E_GHQ)
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

const PREVIEW = 'git -C {} log --oneline -10';

// Interactive pick. fzf renders on /dev/tty and writes only the selection to
// stdout, so capturing stdout here does not disturb the UI.
function fzfPick(candidates) {
  const args = [
    '--height=40%',
    '--layout=reverse',
    '--border',
    '--prompt=repo> ',
    `--preview=${PREVIEW}`,
  ];
  if (query) {
    // With a query, a single surviving candidate is unambiguous — take it
    // rather than making the user press Enter on a one-item list.
    args.push(`--query=${query}`, '--select-1', '--exit-0');
  }
  const r = spawnSync('fzf', args, {
    input: candidates.join('\n') + '\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (r.error) die('E_FZF', `could not run fzf: ${r.error.message}`);
  if (r.status === 130 || r.signal === 'SIGINT') die('E_INTERRUPTED', 'cancelled');
  if (r.status === 1) {
    die('E_NO_MATCH', query
      ? `no repository matched '${query}'`
      : 'no repository selected');
  }
  if (r.status !== 0) die('E_FZF', `fzf exited with status ${r.status}`);
  const sel = (r.stdout ?? '').trim();
  if (!sel) die('E_INTERRUPTED', 'cancelled');
  return sel;
}

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

// ── main flow ────────────────────────────────────────────────────────────────

async function main() {
  await ensureTool('git');
  await ensureTool('ghq');
  await ensureTool('fzf');

  const roots = ghqRoots();
  const root = roots[roots.length - 1] ?? ''; // the primary, for the `root` field
  const slugOf = (p) => {
    for (const r of roots) if (p.startsWith(`${r}/`)) return p.slice(r.length + 1);
    return p;
  };

  const repos = listRepos();
  if (repos.length === 0) {
    die('E_NO_MATCH', 'ghq has no repositories. Clone one with `ghq get <url>` first.');
  }

  // ── --list ────────────────────────────────────────────────────────────────
  if (values.list) {
    const shown = query ? fzfFilter(repos, query) : repos;
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
  if (isNonInteractive) {
    if (!query) {
      die('E_AMBIGUOUS',
        'no terminal for the fzf UI. Pass a query to pick non-interactively, ' +
        'or use --list to see every candidate.');
    }
    const hits = fzfFilter(repos, query);
    if (hits.length === 0) die('E_NO_MATCH', `no repository matched '${query}'`);
    // fzf --filter is score-ordered, so the head is the best match. `matches`
    // travels in the payload so a caller can notice the choice was not unique.
    selected = hits[0];
    matches = hits.length;
  } else {
    selected = fzfPick(repos);
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

main().catch((err) => {
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
