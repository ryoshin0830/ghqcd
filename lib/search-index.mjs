// The search index behind the one search window and --index. Loaded with a
// dynamic import.
//
// Two layers, both under the cache directory:
//   index.json        README / description / issue text per repository
//   vectors.{json,f32}, chunks.json   embeddings for meaning search (on by default)
//
// The embedding runtime is not a dependency of ghqcd (I9). The first `--index`
// installs the exact versions pinned in lib/runtime/package-lock.json into the
// cache with `npm ci --ignore-scripts`, and downloads one pinned, hash-checked
// model from Hugging Face. Meaning search runs on this machine.
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

export const alive = (pid) => {
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
  const release = () => { process.off('exit', release); rmSync(f, { force: true }); };
  process.on('exit', release);
  return release;
}

// When each layer was last built and how long its parts took, for the
// "indexed 2 h ago, a refresh takes ~10 s" hints. Timestamps are epoch ms.
//   textAt, textSeconds                 --index (README read + GitHub fetch)
//   semanticAt, loadSeconds, secondsPerChunk   the vectors part of --index
export function readStatus(env = process.env) {
  try { return JSON.parse(readFileSync(join(cacheDir(env), 'status.json'), 'utf8')); } catch { return {}; }
}
// What a running --index is doing, for the window's status bar:
// { pid, at, text } while it runs, { pid, at, done: true, text } at the end.
export function readProgress(env = process.env) {
  try { return JSON.parse(readFileSync(join(cacheDir(env), 'progress.json'), 'utf8')); } catch { return null; }
}
export function writeProgress(p, env = process.env) {
  writePrivate(join(privateDir(cacheDir(env)), 'progress.json'), JSON.stringify({ pid: process.pid, at: Date.now(), ...p }));
}
function writeStatus(env, patch) {
  writePrivate(join(privateDir(cacheDir(env)), 'status.json'), JSON.stringify({ ...readStatus(env), ...patch }));
}

// ── text index ───────────────────────────────────────────────────────────────

export function readTextIndex(dir = cacheDir()) {
  const f = join(dir, 'index.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

// What the one search window searches: the index, plus clones ghq knows that
// the index has not seen yet (name only). A repository cloned since the last
// index run is listed once, as the clone, with what the index knew about it.
// Each doc: { key, slug, name, cloned, pushedAt, description, readme, issues }.
export function readDocs(paths, slugOf, env = process.env) {
  const repos = readTextIndex(cacheDir(env))?.repos ?? {};
  const here = new Set(paths);
  // An indexed clone that is gone from disk is offered for cloning again.
  const bySlug = new Map(Object.entries(repos).map(([key, r]) => [r.slug, here.has(key) ? { key, ...r, cloned: true } : { ...r, key: r.slug, cloned: false }]));
  for (const path of paths) {
    const slug = slugOf(path);
    const known = bySlug.get(slug);
    bySlug.set(slug, { ...(known ?? { slug, name: basename(path), issues: [] }), key: path, cloned: true });
  }
  return [...bySlug.values()];
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
export function tokenFor(host, env = process.env) {
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
    signal: AbortSignal.timeout(30000), // a hung host must not hang the index
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
const ISSUES_Q = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issues(first:$n,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title body}}}}`;

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// Two listings per host. Your repositories (owned, or shared with you) come
// with their README text, issues and vectors, so one that is not cloned can be
// found by what it says. Everything else you can see as an org member (2,044 on
// one GHE host) comes with name, description and last push only: a README for
// each took minutes per host and would have been embedded for hours.
const VIEWER_Q = `query($after:String){viewer{repositories(first:100,after:$after,affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER]){pageInfo{hasNextPage endCursor}nodes{nameWithOwner description viewerPermission pushedAt r1:object(expression:"HEAD:README.md"){...on Blob{text}} r2:object(expression:"HEAD:readme.md"){...on Blob{text}} r3:object(expression:"HEAD:README"){...on Blob{text}}}}}}`;
const ORG_Q = `query($after:String){viewer{repositories(first:100,after:$after,ownerAffiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER]){pageInfo{hasNextPage endCursor}nodes{nameWithOwner description pushedAt}}}}`;
const VIEWER_PAGES = 50; // ponytail: 5,000 repositories per host and listing; raise if someone has more

async function* pages(url, token, query) {
  let after = null;
  for (let page = 0; page < VIEWER_PAGES; page++) {
    const list = (await graphql(url, token, query, { after })).viewer.repositories;
    yield list.nodes;
    if (!list.pageInfo.hasNextPage) return;
    after = list.pageInfo.endCursor;
  }
}

// The index has one entry per repository, cloned or not. A clone is keyed by
// its path, anything else by host/owner/name; a clone is never listed twice.
// repos: [{path, slug}] for the clones ghq knows.
export async function buildTextIndex(repos, { env = process.env, progress = () => {} } = {}) {
  const t0 = Date.now();
  const prev = readTextIndex(cacheDir(env))?.repos ?? {};
  const out = {};
  const stats = { repos: repos.length, remote: 0, readmes: 0, github: 0, issues: 0, skipped: 0, errors: 0 };
  const fail = (what, e) => { stats.errors++; stats.firstError ??= `${what}: ${e.message}`; };
  const bySlug = new Map();
  for (const r of repos) {
    out[r.path] = { slug: r.slug, name: basename(r.path), cloned: true, pushedAt: '', description: '', readme: readReadme(r.path), issues: [] };
    bySlug.set(r.slug, r.path);
  }
  const onGitHub = (slug) => slug.split('/').length === 3 && !slug.startsWith('gist.github.com/');
  const hostOf = (slug) => slug.split('/')[0];
  // No token or a rejected one is no news about a repository: keep what the last run fetched.
  const keep = (key) => {
    if (out[key]) Object.assign(out[key], { description: prev[key]?.description ?? '', pushedAt: prev[key]?.pushedAt ?? '', issues: prev[key]?.issues ?? [] });
    else if (prev[key]) out[key] = prev[key];
  };
  const keepHost = (host) => {
    for (const [k, v] of Object.entries(prev)) if (v.cloned === false && hostOf(v.slug) === host && !bySlug.has(v.slug) && !out[k]) out[k] = v;
  };

  const hosts = new Set(['github.com', ...repos.map((r) => r.slug).filter(onGitHub).map(hostOf)]);
  const tokens = new Map([...hosts].map((h) => [h, tokenFor(h, env)]));
  const writable = new Map(); // key → host
  const listed = new Set();
  const failedHosts = new Set();
  for (const host of hosts) {
    const token = tokens.get(host);
    if (!token) { keepHost(host); continue; }
    const url = graphqlEndpoint(host, env);
    try {
      for await (const nodes of pages(url, token, VIEWER_Q)) {
        for (const n of nodes) {
          const slug = `${host}/${n.nameWithOwner}`;
          const key = bySlug.get(slug) ?? slug;
          if (!out[key]) {
            out[key] = { slug, name: n.nameWithOwner.split('/')[1], cloned: false, readme: ((n.r1 ?? n.r2 ?? n.r3)?.text ?? '').slice(0, README_MAX), issues: [] };
            stats.remote++;
          }
          Object.assign(out[key], { description: n.description ?? '', pushedAt: n.pushedAt ?? '' });
          listed.add(key);
          stats.github++;
          // Issues only for repositories you can write to: they are your projects.
          // Someone else's tracker would drown your own in the ranking.
          if (WRITABLE.has(n.viewerPermission)) writable.set(key, host);
        }
        progress(`listing your repositories on ${host}: ${stats.github} so far`);
      }
      let seen = 0;
      for await (const nodes of pages(url, token, ORG_Q)) {
        for (const n of nodes) {
          const slug = `${host}/${n.nameWithOwner}`;
          if (out[bySlug.get(slug) ?? slug]) continue;
          out[slug] = { slug, name: n.nameWithOwner.split('/')[1], cloned: false, lite: true, description: n.description ?? '', pushedAt: n.pushedAt ?? '', readme: '', issues: [] };
          stats.remote++;
        }
        progress(`listing repositories your organizations share on ${host}: ${(seen += nodes.length)} so far`);
      }
    } catch (e) {
      fail(host, e);
      failedHosts.add(host);
      keepHost(host);
    }
  }

  // Clones the listings did not cover (someone else's repository): description and permission.
  const rest = repos.filter((r) => !listed.has(r.path));
  await pool(rest, 8, async (r) => {
    const host = hostOf(r.slug);
    if (!onGitHub(r.slug) || !tokens.get(host)) { keep(r.path); stats.skipped++; return; }
    if (failedHosts.has(host)) { keep(r.path); return; }
    const [, owner, name] = r.slug.split('/');
    try {
      const repo = (await graphql(graphqlEndpoint(host, env), tokens.get(host), REPO_Q, { owner, name })).repository;
      if (!repo) { stats.skipped++; return; }
      stats.github++;
      out[r.path].description = repo.description ?? '';
      if (WRITABLE.has(repo.viewerPermission)) writable.set(r.path, host);
    } catch (e) {
      fail(r.slug, e);
      keep(r.path);
    }
  });

  let done = 0;
  await pool([...writable], 8, async ([key, host]) => {
    const [, owner, name] = out[key].slug.split('/');
    try {
      const iss = (await graphql(graphqlEndpoint(host, env), tokens.get(host), ISSUES_Q, { owner, name, n: ISSUES_PER_REPO })).repository.issues.nodes;
      out[key].issues = iss.map(({ number, title, body }) => ({ number, title, body: body ?? '' }));
      stats.issues += iss.length;
    } catch (e) {
      fail(out[key].slug, e);
      out[key].issues = prev[key]?.issues ?? [];
    }
    progress(`reading issues from GitHub: ${++done} of ${writable.size} repositories`);
  });
  stats.readmes = Object.values(out).filter((x) => x.readme).length;
  const index = { repos: out };
  writePrivate(join(privateDir(cacheDir(env)), 'index.json'), JSON.stringify(index));
  writeStatus(env, { textAt: Date.now(), textSeconds: (Date.now() - t0) / 1000 });
  return { index, stats };
}

export const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

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

async function download(url, file, sha256, progress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let got = 0, pct = -1;
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), async function* (src) {
    for await (const c of src) {
      hash.update(c); got += c.length;
      const now = total ? Math.floor((100 * got) / total) : -1;
      if (now !== pct) { pct = now; progress(`downloading ${basename(file)}: ${pct}% of ${Math.round(total / 1e6)} MB`); }
      yield c;
    }
  }, createWriteStream(tmp, { mode: 0o600 }));
  if (hash.digest('hex') !== sha256) { rmSync(tmp, { force: true }); throw new Error(`checksum mismatch for ${url}`); }
  renameSync(tmp, file);
}

async function ensureModel(dir, log, progress, env) {
  const md = privateDir(join(dir, 'models', MODEL.key));
  const base = `${env.HF_ENDPOINT || 'https://huggingface.co'}/${MODEL.repo}/resolve/${MODEL.rev}`;
  let told = false;
  for (const [f, sha] of Object.entries(MODEL.files)) {
    const file = join(md, basename(f));
    if (existsSync(file)) continue;
    if (!told) log(`downloading the embedding model ${MODEL.repo} (about 1.2 GB, once), checked against pinned SHA-256 hashes`);
    told = true;
    await download(`${base}/${f}`, file, sha, progress);
  }
  return md;
}

export async function loadEmbedder({ env = process.env, log = () => {}, progress = () => {}, install = false, threads = Math.min(8, availableParallelism()) } = {}) {
  const dir = cacheDir(env);
  const rt = install ? ensureRuntime(dir, log) : runtimeDir(dir);
  const md = install ? await ensureModel(dir, log, progress, env) : join(dir, 'models', MODEL.key);
  if (!existsSync(join(rt, 'node_modules', '.ghqcd-ok')) || !Object.keys(MODEL.files).every((f) => existsSync(join(md, basename(f))))) {
    throw Object.assign(new Error('no embedding model yet. Run `ghqcd --index` first.'), { code: 'E_INDEX' });
  }
  const req = createRequire(join(rt, 'package.json'));
  const load = async (m) => { const x = await import(pathToFileURL(req.resolve(m)).href); return x.default ?? x; };
  const ort = await load('onnxruntime-web');
  const { Tokenizer } = await load('@huggingface/tokenizers');
  ort.env.wasm.numThreads = threads;
  const tok = new Tokenizer(JSON.parse(readFileSync(join(md, 'tokenizer.json'), 'utf8')),
    JSON.parse(readFileSync(join(md, 'tokenizer_config.json'), 'utf8')));
  const t0 = Date.now();
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

  return {
    embed, chunk, embedQuery: (q) => embed(`${MODEL.queryPrompt}${q}`), release: () => session.release?.(),
    loadSeconds: (Date.now() - t0) / 1000,
  };
}

// ── vector index ─────────────────────────────────────────────────────────────

export const duration = (sec) => (sec < 90 ? `${Math.max(1, Math.round(sec))} s` : `${Math.round(sec / 60)} min`);

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
export async function buildVectors(index, { env = process.env, log = () => {}, progress = () => {} } = {}) {
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
  const add = async (path, kind, number, text) => {
    const src = sha(`${CHUNKING}\0${kind}\0${text}`);
    const old = prev.get(`${path}\0${number ?? ''}\0${src}`);
    if (old?.every((c) => known.has(c.key))) return void chunks.push(...old);
    emb ??= await loadEmbedder({ env, log, progress, install: true });
    changed++;
    const cs = emb.chunk(text);
    for (const c of kind === 'issue' ? cs.slice(0, 1) : cs) chunks.push({ key: sha(c), src, path, kind, number, text: c });
  };
  for (const [path, r] of Object.entries(index.repos)) {
    if (r.lite) continue; // found by name and description; see VIEWER_Q
    await add(path, 'readme', undefined, [r.name, r.description, r.readme].filter(Boolean).join('\n\n'));
    // One chunk per issue: the title and the start of the body. Long issues
    // averaged 8 chunks on a real machine (3.5 h to embed); the experiment lost
    // 3 of 111 issue questions and no README questions to this cut (M3).
    // 512 tokens never span 8000 chars.
    for (const i of r.issues) await add(path, 'issue', i.number, `${i.title}\n\n${i.body}`.slice(0, 8000));
  }
  const todo = [...new Map(chunks.filter((c) => !known.has(c.key)).map((c) => [c.key, c])).values()];
  const { secondsPerChunk } = readStatus(env);
  const left = (sec) => (sec ? ` · about ${duration(sec)} left` : '');
  if (todo.length) progress(`embedding 0 of ${todo.length}${left(todo.length * (secondsPerChunk ?? 0))}`);
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
      // Every chunk: "ctrl-c stops, the next run resumes" must lose at most the one in flight.
      writePrivate(metaFile, JSON.stringify({ model: MODEL.key, dim, keys }));
      progress(`embedding ${n + 1} of ${todo.length}${left(((Date.now() - t0) / (n + 1)) * (todo.length - n - 1) / 1000)}`);
    }
  } finally {
    closeSync(fd);
  }
  emb?.release();
  writeStatus(env, {
    semanticAt: Date.now(),
    ...(emb && { loadSeconds: emb.loadSeconds }),
    // A rate from one or two chunks is mostly warm-up noise.
    ...(todo.length >= 10 && { secondsPerChunk: (Date.now() - t0) / 1000 / todo.length }),
  });
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
// Meaning search for the one window: the model loads on the first query and
// stays loaded; chunks and vectors are re-read whenever an index run rewrote
// them. Returns the best chunk per repository, issue chunks scored 0.1 lower,
// at most 20, none below 0.45: [{ key, score, kind, number, snippet }].
export function meaningSearch(env = process.env) {
  let emb, seen, chunks, row, dim, data;
  return async (query) => {
    const dir = cacheDir(env);
    const cf = join(dir, `chunks-${MODEL.key}.json`);
    if (!existsSync(cf)) return [];
    const stamp = statSync(cf).mtimeMs;
    if (stamp !== seen) {
      chunks = JSON.parse(readFileSync(cf, 'utf8'));
      ({ dim, data } = readVectors(dir));
      row = new Map(readVectors(dir).keys.map((k, i) => [k, i]));
      seen = stamp;
    }
    // One thread: a query is one short text, and on Node 20 starting ORT's
    // thread pool sometimes spun forever inside session creation (1 run in 15).
    emb ??= await loadEmbedder({ env, threads: 1 });
    const q = await emb.embedQuery(query);
    const best = new Map();
    for (const c of chunks) {
      const i = row.get(c.key);
      if (i === undefined) continue;
      let s = 0;
      for (let j = 0, o = i * dim; j < dim; j++) s += q[j] * data[o + j];
      if (c.kind === 'issue') s -= MODEL.issuePenalty;
      const b = best.get(c.path);
      if (!b || s > b.score) best.set(c.path, { key: c.path, score: s, kind: c.kind, number: c.number, snippet: c.preview });
    }
    // 0.45: correct answers scored 0.47–0.77 in the Docker check; unrelated
    // README tables reached 0.42 for identifier-like queries.
    return [...best.values()].filter((b) => b.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 20);
  };
}
