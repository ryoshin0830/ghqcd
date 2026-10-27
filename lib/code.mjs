// Code hits for the one search window, shown last (the user's order: name >
// description > README > issues > code). Clones are searched with git grep, on
// this machine. Repositories that are not cloned go to GitHub's code search,
// once the query has been still for a moment, and at most 10 times a minute
// per host (GitHub's limit for code search).
import { spawn } from 'node:child_process';
import { flat } from './rank.mjs';
import { README_EXTS, README_RE } from './search-index.mjs';

const MIN_CHARS = 3;
const AT_ONCE = 8;
const GREP_MS = 3000; // a huge clone may not hold up the rest
const PAUSE_MS = 700;
const PER_MINUTE = 10;
const asked = new Map(); // host → times of recent code searches
const logins = new Map(); // host → your login there

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, Math.max(0, ms)); // a negative delay warns into the window
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// The first matching line in a clone: `file:line:text`, or null. Not in the
// top-level README (README_RE): that is a readme hit, already shown above, and
// git grep's byte order would put it before every file under src/.
const NOT_README = ['.', ...['', ...README_EXTS.map((e) => `.${e}`)].map((e) => `:(exclude,icase)readme${e}`)];
function grep(dir, text, signal) {
  return new Promise((resolve) => {
    // core.quotePath=false: 設計.md, not "\350\250\255\350\250\210.md".
    const git = spawn('git', ['-C', dir, '-c', 'core.quotePath=false', 'grep', '-n', '-I', '-i', '-F', '--max-count=1', '-e', text, '--', ...NOT_README], { stdio: ['ignore', 'pipe', 'ignore'], signal });
    let out = '';
    git.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) git.kill();
    });
    const stop = setTimeout(() => git.kill(), GREP_MS);
    git.on('error', () => resolve(null));
    git.on('close', () => { clearTimeout(stop); resolve(out.split('\n')[0] || null); });
  });
}

const restBase = (host) => (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`);
async function rest(host, token, path, accept = 'application/vnd.github+json') {
  const res = await fetch(`${restBase(host)}${path}`, {
    headers: { authorization: `bearer ${token}`, accept, 'user-agent': 'ghqcd' }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
function allowed(host) {
  const now = Date.now();
  const recent = (asked.get(host) ?? []).filter((t) => now - t < 60000);
  asked.set(host, recent);
  if (recent.length >= PER_MINUTE) return false;
  recent.push(now);
  return true;
}

// docs: the window's documents. token(host) → string | null.
// Yields { key, loc, snippet }, at most one per repository.
export async function* codeSearch({ docs, query, signal, token = () => null }) {
  const text = query.trim();
  if (text.length < MIN_CHARS || signal.aborted) return;
  const t0 = Date.now();
  // Clones (AT_ONCE at a time) and GitHub (after the pause) at the same time;
  // each hit is yielded as soon as it is found.
  const queue = docs.filter((d) => d.cloned);
  const ready = [];
  let wake = () => {};
  const found = (hit) => { ready.push(hit); wake(); };
  let running = 0;
  const next = () => {
    while (running < AT_ONCE && queue.length && !signal.aborted) {
      const d = queue.shift();
      running++;
      grep(d.key, text, signal).then((line) => {
        running--;
        const m = line?.match(/^(.*?):(\d+):(.*)$/);
        if (m) found({ key: d.key, loc: `${m[1]}:${m[2]}`, snippet: `${m[1]}:${m[2]} ${flat(m[3])}` });
        next();
        wake();
      });
    }
  };
  next();
  let remote = true;
  searchGitHub(docs.filter((d) => !d.cloned), text, signal, token, t0, found).finally(() => { remote = false; wake(); });
  while ((running || remote || ready.length) && !signal.aborted) {
    if (!ready.length) await new Promise((r) => { wake = r; });
    while (ready.length && !signal.aborted) yield ready.shift();
  }
}

async function searchGitHub(far, text, signal, token, t0, found) {
  if (!far.length) return;
  await sleep(PAUSE_MS - (Date.now() - t0), signal);
  const bySlug = new Map(far.map((d) => [d.slug, d]));
  for (const host of new Set(far.map((d) => d.slug.split('/')[0]))) {
    const tk = token(host);
    if (signal.aborted || !tk || !allowed(host)) continue;
    try {
      if (!logins.has(host)) logins.set(host, (await rest(host, tk, '/user')).login);
      const q = encodeURIComponent(`${text} user:${logins.get(host)}`);
      const res = await rest(host, tk, `/search/code?q=${q}&per_page=30`, 'application/vnd.github.text-match+json');
      const shown = new Set();
      for (const item of res.items ?? []) {
        const doc = bySlug.get(`${host}/${item.repository.full_name}`);
        if (!doc || shown.has(doc.key) || README_RE.test(item.path) || signal.aborted) continue;
        shown.add(doc.key);
        found({ key: doc.key, loc: item.path, snippet: `${item.path} ${flat(item.text_matches?.[0]?.fragment)}`.slice(0, 120) });
      }
    } catch {
      // Code search is the last, optional tier: a failure shows nothing.
    }
  }
}
