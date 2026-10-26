// The search index behind --index, --issues and --semantic. Loaded with a
// dynamic import, so the plain picker never parses this file.
//
// Two layers, both under the cache directory:
//   index.json        README / description / issue text per repository
//   vectors.{json,f32}, chunks.json   embeddings for --semantic (opt-in)
//
// The embedding runtime is not a dependency of ghqcd (I9). `--index --semantic`
// installs the exact versions pinned in lib/runtime/package-lock.json into the
// cache with `npm ci --ignore-scripts`, and downloads one pinned, hash-checked
// model from Hugging Face. Nothing leaves the machine at query time.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export const MODEL = {
  key: 'qwen3-embedding-0.6b-fp16-c25a394',
  repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
  rev: 'c25a394dd583836952667c12f008335071b3f43d',
  files: {
    'tokenizer.json': 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a',
    'tokenizer_config.json': '977648852447cb6587327ff3205b0a84cf2fc9f05621d6c8e88a497caafab2e1',
    // fp16 matches the reference FP32 model (cosine 1.0000); the int8 export
    // does not (median 0.835) and lost a tenth of the hits. See the plan doc.
    'onnx/model_fp16.onnx': 'f376cf065d912675dd559270e19361367ebc28c938b9811dd61d5834c78d0834',
    'onnx/model_fp16.onnx_data': '06fbfded30166e3a33fe5252d7002ed1c370a4ec1bf45aba778cdf6cf7d31439',
  },
  // Qwen3-Embedding's own query prompt; documents get none.
  queryPrompt: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:',
  maxTokens: 512,
  // A repository with many issues has many chances to match by accident. Issue
  // chunks are scored this much lower than README chunks (docs/research/semantic-search-plan.md).
  issuePenalty: 0.1,
};

const RUNTIME_SRC = new URL('./runtime/', import.meta.url);
const README_RE = /^readme(\.(md|markdown|mdown|rst|txt|org|adoc))?$/i;
const README_MAX = 256 * 1024;
const ISSUES_PER_REPO = 100; // ponytail: most recently updated 100; paginate if people need older ones
const WRITABLE = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

export function cacheDir(env = process.env) {
  if (env.GHQCD_CACHE_DIR) return env.GHQCD_CACHE_DIR;
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'ghqcd');
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ghqcd');
}

// Index files hold private issue text: owner-only, written atomically.
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function writePrivate(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// One --index at a time: two runs appending to the same vector file corrupt it.
// A lock left by a killed run names a dead pid and is taken over.
export function lockIndex(env = process.env) {
  const f = join(privateDir(cacheDir(env)), 'index.lock');
  for (;;) {
    try {
      writeFileSync(f, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(f, 'utf8')); // empty: another run is writing it right now
      if (!pid || alive(pid)) {
        throw Object.assign(new Error(`another \`ghqcd --index\` is running (pid ${pid || '?'})`), { code: 'E_INDEX' });
      }
      rmSync(f, { force: true });
    }
  }
  process.on('exit', () => rmSync(f, { force: true }));
}

// Days since the index (for --semantic: its vectors) was built; null if never.
export function indexAgeDays(semantic, env = process.env) {
  const f = join(cacheDir(env), semantic ? `chunks-${MODEL.key}.json` : 'index.json');
  return existsSync(f) ? (Date.now() - statSync(f).mtimeMs) / 864e5 : null;
}

// ── text index ───────────────────────────────────────────────────────────────

export function readTextIndex(dir = cacheDir()) {
  const f = join(dir, 'index.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

function readReadme(repoPath) {
  let names;
  try { names = readdirSync(repoPath); } catch { return ''; }
  const name = names.filter((n) => README_RE.test(n)).sort((a, b) => a.length - b.length)[0];
  if (!name) return '';
  const buf = readFileSync(join(repoPath, name));
  return buf.subarray(0, README_MAX).toString('utf8');
}

// One token per host. github.com: GH_TOKEN / GITHUB_TOKEN; any host: `gh auth token`.
function tokenFor(host, env) {
  if (host === 'github.com' && (env.GH_TOKEN || env.GITHUB_TOKEN)) return env.GH_TOKEN || env.GITHUB_TOKEN;
  if (host !== 'github.com' && env.GH_ENTERPRISE_TOKEN) return env.GH_ENTERPRISE_TOKEN;
  const r = spawnSync('gh', ['auth', 'token', '--hostname', host], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function graphqlEndpoint(host, env) {
  if (env.GHQCD_GITHUB_API) return env.GHQCD_GITHUB_API; // tests and proxies
  return host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
}

async function graphql(url, token, query, variables) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'ghqcd' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  // NOT_FOUND (deleted, renamed, or no access) comes back as a null repository: a skip, not an error.
  const err = body.errors?.find((e) => e.type !== 'NOT_FOUND');
  if (err) throw new Error(err.message);
  return body.data;
}

const REPO_Q = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){description viewerPermission}}`;
const ISSUES_Q = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issues(first:$n,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title body state}}}}`;

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// repos: [{path, slug}] where slug is host/owner/name for ghq-managed clones.
export async function buildTextIndex(repos, { env = process.env, log = () => {} } = {}) {
  const tokens = new Map();
  const prev = readTextIndex(cacheDir(env))?.repos ?? {};
  const out = {};
  const stats = { repos: repos.length, readmes: 0, github: 0, issues: 0, skipped: 0, errors: 0 };
  for (const r of repos) {
    const [host, owner, name] = r.slug.split('/');
    out[r.path] = { slug: r.slug, name: basename(r.path), description: '', readme: readReadme(r.path), issues: [] };
    if (out[r.path].readme) stats.readmes++;
    r.remote = owner && name && r.slug.split('/').length === 3 && host !== 'gist.github.com' ? { host, owner, name } : null;
  }
  const remote = repos.filter((r) => r.remote);
  let done = 0;
  await pool(remote, 8, async (r) => {
    const { host, owner, name } = r.remote;
    if (!tokens.has(host)) tokens.set(host, tokenFor(host, env));
    const token = tokens.get(host);
    const keep = () => {
      out[r.path].description = prev[r.path]?.description ?? '';
      out[r.path].issues = prev[r.path]?.issues ?? [];
    };
    // No token or a rejected one is no news about the repository: keep what the last run fetched.
    if (!token) { keep(); stats.skipped++; return; }
    const url = graphqlEndpoint(host, env);
    try {
      const repo = (await graphql(url, token, REPO_Q, { owner, name })).repository;
      if (!repo) { stats.skipped++; return; }
      stats.github++;
      out[r.path].description = repo.description ?? '';
      // Issues only for repositories you can write to: they are your projects.
      // Someone else's tracker would drown your own in the ranking.
      if (WRITABLE.has(repo.viewerPermission)) {
        const iss = (await graphql(url, token, ISSUES_Q, { owner, name, n: ISSUES_PER_REPO })).repository.issues.nodes;
        out[r.path].issues = iss.map((x) => ({ number: x.number, title: x.title, body: x.body ?? '', state: x.state }));
        stats.issues += iss.length;
      }
    } catch (e) {
      keep();
      stats.errors++;
      stats.firstError ??= `${r.slug}: ${e.message}`;
    }
    if (++done % 20 === 0) log(`  github ${done}/${remote.length}`);
  });
  const index = { version: 1, builtAt: new Date().toISOString(), repos: out };
  writePrivate(join(privateDir(cacheDir(env)), 'index.json'), JSON.stringify(index));
  return { index, stats };
}

// fzf lines for --issues: `<path>\t<what fzf shows and searches>`.
export function issueLines(index) {
  const flat = (s) => s.replace(/\s+/g, ' ').trim();
  const lines = [];
  for (const [path, r] of Object.entries(index?.repos ?? {})) {
    for (const i of r.issues) lines.push(`${path}\t${r.slug}  #${i.number} ${flat(i.title)}  ${flat(i.body)}`);
  }
  return lines;
}

// ── embedding runtime ────────────────────────────────────────────────────────

function runtimeDir(dir) {
  const lock = readFileSync(new URL('package-lock.json', RUNTIME_SRC));
  return join(dir, 'runtime', createHash('sha256').update(lock).digest('hex').slice(0, 12));
}

function ensureRuntime(dir, log) {
  const rt = runtimeDir(dir);
  if (existsSync(join(rt, 'node_modules', '.ghqcd-ok'))) return rt;
  log(`installing the embedding runtime (onnxruntime-web, tokenizers) into ${rt}`);
  rmSync(rt, { recursive: true, force: true });
  privateDir(rt);
  for (const f of ['package.json', 'package-lock.json']) copyFileSync(new URL(f, RUNTIME_SRC), join(rt, f));
  const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: rt, stdio: ['ignore', 2, 2], shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`npm ci failed in ${rt}`);
  writeFileSync(join(rt, 'node_modules', '.ghqcd-ok'), '');
  return rt;
}

async function download(url, file, sha256, log) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let got = 0, shown = 0;
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), async function* (src) {
    for await (const c of src) {
      hash.update(c); got += c.length;
      if (total && got - shown > total / 20) { shown = got; log(`  ${basename(file)} ${Math.round((100 * got) / total)}%`); }
      yield c;
    }
  }, createWriteStream(tmp, { mode: 0o600 }));
  if (hash.digest('hex') !== sha256) { rmSync(tmp, { force: true }); throw new Error(`checksum mismatch for ${url}`); }
  renameSync(tmp, file);
}

async function ensureModel(dir, log, env) {
  const md = privateDir(join(dir, 'models', MODEL.key));
  const base = `${env.HF_ENDPOINT || 'https://huggingface.co'}/${MODEL.repo}/resolve/${MODEL.rev}`;
  for (const [f, sha] of Object.entries(MODEL.files)) {
    const file = join(md, basename(f));
    if (existsSync(file)) continue;
    log(`downloading ${MODEL.repo} ${f}`);
    await download(`${base}/${f}`, file, sha, log);
  }
  return md;
}

export async function loadEmbedder({ env = process.env, log = () => {}, install = false, threads = Math.min(8, availableParallelism()) } = {}) {
  const dir = cacheDir(env);
  const rt = install ? ensureRuntime(dir, log) : runtimeDir(dir);
  const md = install ? await ensureModel(dir, log, env) : join(dir, 'models', MODEL.key);
  if (!existsSync(join(rt, 'node_modules', '.ghqcd-ok')) || !Object.keys(MODEL.files).every((f) => existsSync(join(md, basename(f))))) {
    throw Object.assign(new Error('no embedding model yet. Run `ghqcd --index --semantic` first.'), { code: 'E_INDEX' });
  }
  const req = createRequire(join(rt, 'package.json'));
  const load = async (m) => { const x = await import(pathToFileURL(req.resolve(m)).href); return x.default ?? x; };
  const ort = await load('onnxruntime-web');
  const { Tokenizer } = await load('@huggingface/tokenizers');
  ort.env.wasm.numThreads = threads;
  const tok = new Tokenizer(JSON.parse(readFileSync(join(md, 'tokenizer.json'), 'utf8')),
    JSON.parse(readFileSync(join(md, 'tokenizer_config.json'), 'utf8')));
  const session = await ort.InferenceSession.create(readFileSync(join(md, 'model_fp16.onnx')), {
    executionProviders: ['wasm'],
    externalData: [{ path: 'model_fp16.onnx_data', data: readFileSync(join(md, 'model_fp16.onnx_data')) }],
  });
  const meta = Object.fromEntries(session.inputMetadata.map((m) => [m.name, m]));
  const i64 = (a) => BigInt64Array.from(a, BigInt);
  // Node < 24 has no Float16Array; ORT then takes and returns raw half bits.
  const F16 = globalThis.Float16Array ?? Uint16Array;
  const half = (b) => {
    const e = (b >> 10) & 31, f = b & 1023, sign = b >> 15 ? -1 : 1;
    if (e === 0) return sign * 2 ** -14 * (f / 1024);
    if (e === 31) return f ? NaN : sign * Infinity;
    return sign * 2 ** (e - 15) * (1 + f / 1024);
  };
  const toF32 = (t) => (t.data instanceof Uint16Array ? Float32Array.from(t.data, half) : Float32Array.from(t.data));
  const ntok = (t) => tok.encode(t).ids.length;

  async function embed(text) {
    const ids = tok.encode(text).ids;
    const n = ids.length;
    const feeds = {
      input_ids: new ort.Tensor('int64', i64(ids), [1, n]),
      attention_mask: new ort.Tensor('int64', i64(ids.map(() => 1)), [1, n]),
      position_ids: new ort.Tensor('int64', i64(ids.map((_, i) => i)), [1, n]),
    };
    // The export is a decoder with a KV cache; an embedding pass starts it empty.
    for (const [name, m] of Object.entries(meta)) {
      if (name.startsWith('past_key_values')) {
        const shape = m.shape.map((d) => (d === 'batch_size' ? 1 : typeof d === 'number' ? d : 0));
        feeds[name] = new ort.Tensor(m.type, m.type === 'float16' ? new F16(0) : new Float32Array(0), shape);
      }
    }
    const h = (await session.run(feeds, ['last_hidden_state'])).last_hidden_state;
    const d = h.dims.at(-1);
    const v = toF32(h).slice((n - 1) * d, n * d); // last-token pooling
    let s = 0; for (const x of v) s += x * x;
    s = Math.sqrt(s);
    return v.map((x) => x / s);
  }

  // Pack paragraphs up to the token budget; split only oversized paragraphs,
  // with a 64-token overlap. Same rule the experiment measured (poc/run_issues.py).
  function chunk(text) {
    const max = MODEL.maxTokens, budget = max - ntok('');
    const out = [];
    let cur = '';
    for (const para of text.split('\n\n').map((p) => p.trim()).filter(Boolean)) {
      if (ntok(para) > budget) {
        if (cur) { out.push(cur); cur = ''; }
        const ids = tok.encode(para, { add_special_tokens: false }).ids;
        for (let i = 0; i < ids.length; i += budget - 64) {
          let k = budget;
          while (ntok(tok.decode(ids.slice(i, i + k))) > max) k -= 8;
          out.push(tok.decode(ids.slice(i, i + k)));
          if (i + budget >= ids.length) break;
        }
        continue;
      }
      const cand = cur ? `${cur}\n\n${para}` : para;
      if (ntok(cand) <= budget) cur = cand;
      else { out.push(cur); cur = para; }
    }
    if (cur) out.push(cur);
    return out.length ? out : [text];
  }

  return { embed, chunk, embedQuery: (q) => embed(`${MODEL.queryPrompt}${q}`), release: () => session.release?.() };
}

// ── vector index ─────────────────────────────────────────────────────────────

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
// Bump when chunk() or the text fed to it changes: cached chunk lists are keyed by it.
const CHUNKING = 2;

function readVectors(dir) {
  const meta = join(dir, `vectors-${MODEL.key}.json`), bin = join(dir, `vectors-${MODEL.key}.f32`);
  if (!existsSync(meta) || !existsSync(bin)) return { keys: [], dim: 0, data: new Float32Array(0) };
  const m = JSON.parse(readFileSync(meta, 'utf8'));
  const buf = readFileSync(bin);
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return { keys: m.keys.slice(0, data.length / (m.dim || 1)), dim: m.dim, data };
}

// Embeds every chunk not embedded before. Resumable: vectors are appended as
// they are computed and keyed by the chunk text, so an interrupted run loses
// at most the chunk in flight.
export async function buildVectors(index, { env = process.env, log = () => {} } = {}) {
  const dir = privateDir(cacheDir(env));
  const chunkFile = join(dir, `chunks-${MODEL.key}.json`);
  const have = readVectors(dir);
  const known = new Set(have.keys);
  // Chunking tokenizes every text (20 s for 1,800 chunks), so a text that is
  // unchanged since the last run, with all its vectors present, reuses that
  // run's chunk list. The model loads only when something has to be chunked.
  const prev = new Map();
  for (const c of existsSync(chunkFile) ? JSON.parse(readFileSync(chunkFile, 'utf8')) : []) {
    if (!c.src) continue;
    const id = `${c.path}\0${c.number ?? ''}\0${c.src}`;
    prev.set(id, [...(prev.get(id) ?? []), c]);
  }
  let emb;
  let changed = 0;
  const chunks = [];
  const add = async (path, kind, number, text, firstOnly) => {
    const src = sha(`${CHUNKING}\0${kind}\0${text}`);
    const old = prev.get(`${path}\0${number ?? ''}\0${src}`);
    if (old?.every((c) => known.has(c.key))) return void chunks.push(...old);
    emb ??= await loadEmbedder({ env, log, install: true });
    changed++;
    const cs = emb.chunk(text);
    for (const c of firstOnly ? cs.slice(0, 1) : cs) chunks.push({ key: sha(c), src, path, kind, number, text: c });
  };
  for (const [path, r] of Object.entries(index.repos)) {
    await add(path, 'readme', undefined, [r.name, r.description, r.readme].filter(Boolean).join('\n\n'), false);
    // One chunk per issue: the title and the start of the body. Long issues
    // averaged 8 chunks on a real machine (3.5 h to embed); the experiment lost
    // 3 of 111 issue questions and no README questions to this cut (M3).
    // 512 tokens never span 8000 chars.
    for (const i of r.issues) await add(path, 'issue', i.number, `${i.title}\n\n${i.body}`.slice(0, 8000), true);
  }
  const todo = [...new Map(chunks.filter((c) => !known.has(c.key)).map((c) => [c.key, c])).values()];
  const metaFile = join(dir, `vectors-${MODEL.key}.json`), binFile = join(dir, `vectors-${MODEL.key}.f32`);
  const keys = [...have.keys];
  // A crash between appending a vector and rewriting the key list leaves extra
  // rows; drop them so new rows line up with their keys.
  if (existsSync(binFile)) truncateSync(binFile, keys.length * have.dim * 4);
  const fd = openSync(binFile, 'a', 0o600);
  const t0 = Date.now();
  let dim = have.dim;
  try {
    for (const [n, c] of todo.entries()) {
      // ort's run() resolves without an event-loop turn, so without this
      // SIGTERM / SIGHUP would wait for the whole pass, hours on a big machine.
      await new Promise((r) => setImmediate(r));
      const v = await emb.embed(c.text);
      dim = v.length;
      writeSync(fd, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      keys.push(c.key);
      if (n % 25 === 24 || n === todo.length - 1) {
        writePrivate(metaFile, JSON.stringify({ model: MODEL.key, dim, keys }));
        const eta = Math.round(((Date.now() - t0) / (n + 1)) * (todo.length - n - 1) / 1000);
        log(`  embedded ${n + 1}/${todo.length}${eta ? `, about ${Math.ceil(eta / 60)} min left` : ''}`);
      }
    }
  } finally {
    closeSync(fd);
  }
  emb?.release();
  // Compact: keep only the vectors the current chunks use.
  const live = new Set(chunks.map((c) => c.key));
  if (keys.some((k) => !live.has(k))) {
    const all = readVectors(dir);
    const keep = all.keys.map((k, i) => [k, i]).filter(([k]) => live.has(k));
    const data = new Float32Array(keep.length * all.dim);
    keep.forEach(([, i], j) => data.set(all.data.subarray(i * all.dim, (i + 1) * all.dim), j * all.dim));
    writePrivate(binFile, new Uint8Array(data.buffer));
    writePrivate(metaFile, JSON.stringify({ model: MODEL.key, dim: all.dim, keys: keep.map(([k]) => k) }));
  }
  writePrivate(chunkFile, JSON.stringify(chunks.map(({ key, src, path, kind, number, text, preview }) =>
    ({ key, src, path, kind, number, preview: preview ?? text.slice(0, 200) }))));
  return { chunks: chunks.length, changed, embedded: todo.length };
}

// Ranks repositories for a query. Repo score = max(best README chunk, best issue chunk - penalty).
export async function semanticRank(query, { env = process.env } = {}) {
  const dir = cacheDir(env);
  const cf = join(dir, `chunks-${MODEL.key}.json`);
  if (!existsSync(cf)) {
    throw Object.assign(new Error('no semantic index yet. Run `ghqcd --index --semantic` first.'), { code: 'E_INDEX' });
  }
  const chunks = JSON.parse(readFileSync(cf, 'utf8'));
  const { keys, dim, data } = readVectors(dir);
  const row = new Map(keys.map((k, i) => [k, i]));
  // One thread: a query is one short text, and on Node 20 starting ORT's
  // thread pool sometimes spun forever inside session creation (1 run in 15).
  const emb = await loadEmbedder({ env, threads: 1 });
  const q = await emb.embedQuery(query);
  emb.release();
  const best = new Map();
  for (const c of chunks) {
    const i = row.get(c.key);
    if (i === undefined) continue;
    let s = 0;
    for (let j = 0, o = i * dim; j < dim; j++) s += q[j] * data[o + j];
    if (c.kind === 'issue') s -= MODEL.issuePenalty;
    const b = best.get(c.path);
    if (!b || s > b.score) best.set(c.path, { path: c.path, score: s, kind: c.kind, number: c.number, preview: c.preview });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

