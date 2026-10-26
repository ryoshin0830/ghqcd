// Embed the exact prompted texts run_issues.py --dump wrote, with onnxruntime-web (WASM) in Node.
// usage: node embed.mjs <dump.json> <model dir> <onnx file> <pooling: last|cls|mean> <out.f32> [threads]
// env RT=web (default, WASM) | node (onnxruntime-node, native CPU). env LIMIT=n embeds an evenly spaced sample.
// Prints one JSON line of timings to stdout.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Tokenizer } from '@huggingface/tokenizers';

const [dumpPath, dir, file, pooling, out, threads] = process.argv.slice(2);
const T0 = performance.now();
const RT = process.env.RT || 'web';
const ort = await import(RT === 'node' ? 'onnxruntime-node' : 'onnxruntime-web');
const nThreads = Number(threads || Math.min(8, os.availableParallelism()));
if (RT === 'web') ort.env.wasm.numThreads = nThreads;
const tok = new Tokenizer(JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'))),
                          JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer_config.json'))));
const onnx = path.join(dir, 'onnx', file);
const data = fs.readdirSync(path.join(dir, 'onnx')).filter(f => f.startsWith(file + '_data'))
  .map(f => ({ path: f, data: fs.readFileSync(path.join(dir, 'onnx', f)) }));
const session = RT === 'node'
  ? await ort.InferenceSession.create(onnx, { executionProviders: ['cpu'], intraOpNumThreads: nThreads })
  : await ort.InferenceSession.create(fs.readFileSync(onnx), { executionProviders: ['wasm'], externalData: data });
const loadMs = performance.now() - T0;

const meta = Object.fromEntries(session.inputMetadata.map(m => [m.name, m]));
const i64 = a => BigInt64Array.from(a, BigInt);

async function embed(text) {
  const ids = tok.encode(text).ids;
  const n = ids.length;
  const feeds = {
    input_ids: new ort.Tensor('int64', i64(ids), [1, n]),
    attention_mask: new ort.Tensor('int64', i64(ids.map(() => 1)), [1, n]),
  };
  if (meta.position_ids) feeds.position_ids = new ort.Tensor('int64', i64(ids.map((_, i) => i)), [1, n]);
  if (meta.token_type_ids) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n), [1, n]);
  for (const [name, m] of Object.entries(meta)) {  // decoder exports: empty KV cache
    if (!name.startsWith('past_key_values')) continue;
    const shape = m.shape.map(d => (d === 'batch_size' ? 1 : typeof d === 'number' ? d : 0));
    const Arr = m.type === 'float16' ? (globalThis.Float16Array ?? Uint16Array) : Float32Array;
    feeds[name] = new ort.Tensor(m.type, new Arr(0), shape);
  }
  const res = await session.run(feeds, ['last_hidden_state'].filter(o => session.outputNames.includes(o)).length
    ? ['last_hidden_state'] : [session.outputNames[0]]);
  const h = Object.values(res)[0];
  const d = h.dims.at(-1), v = new Float32Array(d), x = Float32Array.from(h.data);
  if (pooling === 'last') v.set(x.subarray((n - 1) * d, n * d));
  else if (pooling === 'cls') v.set(x.subarray(0, d));
  else for (let t = 0; t < n; t++) for (let j = 0; j < d; j++) v[j] += x[t * d + j] / n;
  const norm = Math.hypot(...v);
  return { v: v.map(y => y / norm), n };
}

let texts = JSON.parse(fs.readFileSync(dumpPath)).texts;
if (process.env.LIMIT) { const k = texts.length / Number(process.env.LIMIT); texts = texts.filter((_, i) => Math.floor(i / k) !== Math.floor((i - 1) / k)); }
const fd = fs.openSync(out, 'w', 0o600);
let tokens = 0;
const T1 = performance.now();
for (const t of texts) {
  const { v, n } = await embed(t);
  tokens += n;
  fs.writeSync(fd, new Uint8Array(v.buffer));
}
fs.closeSync(fd);
const sec = (performance.now() - T1) / 1000;
// Warm single-query latency on short texts (the last 20 dumped texts are queries).
const lat = [];
for (const t of texts.slice(-20)) { const s = performance.now(); await embed(t); lat.push(performance.now() - s); }
lat.sort((a, b) => a - b);
console.log(JSON.stringify({ rt: RT, file, threads: nThreads, load_ms: Math.round(loadMs), texts: texts.length, tokens,
  seconds: +sec.toFixed(1), tokens_per_s: Math.round(tokens / sec), query_p50_ms: Math.round(lat[10]),
  rss_mb: Math.round(process.memoryUsage().rss / 2 ** 20) }));
