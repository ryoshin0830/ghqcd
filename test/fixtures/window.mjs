// Real fzf and application processes; only ghq/GitHub and model inference are fixtures.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL } from '../../lib/search-index.mjs';

export function windowFixture({ vectors = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ghqcd-e2e-'));
  const cache = join(base, 'cache'), shims = join(base, 'bin');
  const root = join(base, 'repos');
  const repos = ['apple', 'berry'].map((n) => join(root, 'github.com', 'fixture', n));
  for (const p of [cache, shims, ...repos]) mkdirSync(p, { recursive: true });
  const executable = (name, text) => writeFileSync(join(shims, name), text, { mode: 0o755 });
  executable('ghq', `#!/bin/sh\ncase "$1" in\nroot) echo '${root}';;\nlist) printf '%s\\n' '${repos[0]}' '${repos[1]}';;\nesac\n`);
  executable('gh', '#!/bin/sh\nexit 1\n');
  const env = { ...process.env, PATH: `${shims}:${process.env.PATH}`, GHQCD_CACHE_DIR: cache,
    GHQCD_TEST_VECTOR_LOG: join(base, 'vector-events'), GHQCD_TEST_PHASE: join(base, 'phase'),
    GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
    TERM: 'xterm-256color', NO_COLOR: '1', SHELL: '/bin/sh',
  };
  delete env.GHQCD_SEMANTIC;
  delete env.FORCE_COLOR;
  delete env.FZF_DEFAULT_OPTS;
  delete env.FZF_DEFAULT_OPTS_FILE;
  writeFileSync(env.GHQCD_TEST_PHASE, 'initial');
  writeFileSync(join(cache, 'index.json'), JSON.stringify({ repos: Object.fromEntries(repos.map((p, i) => [p, {
    name: i ? 'berry' : 'apple', slug: `github.com/fixture/${i ? 'berry' : 'apple'}`, cloned: true,
    description: '', readme: '', issues: [],
  }])) }));
  writeFileSync(join(cache, 'status.json'), JSON.stringify({ textAt: Date.now() - 7200e3,
    ...(vectors && { semanticAt: Date.now() }), textSeconds: 53 }));
  if (vectors) {
    const model = join(cache, 'models', MODEL.key);
    mkdirSync(model, { recursive: true });
    for (const f of Object.keys(MODEL.files)) writeFileSync(join(model, f.split('/').at(-1)), '{}');
    const lock = readFileSync(new URL('../../lib/runtime/package-lock.json', import.meta.url));
    const rt = join(cache, 'runtime', createHash('sha256').update(lock).digest('hex').slice(0, 12));
    mkdirSync(join(rt, 'node_modules'), { recursive: true });
    writeFileSync(join(rt, 'package.json'), '{}');
    writeFileSync(join(rt, 'node_modules', '.ghqcd-ok'), '');
    const module = (name, source) => {
      const dir = join(rt, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.mjs' }));
      writeFileSync(join(dir, 'index.mjs'), source);
    };
    module('@huggingface/tokenizers', `export class Tokenizer {
      encode(s) { return { ids: Array.from(s, (c) => c.codePointAt(0)) }; }
      decode(ids) { return String.fromCodePoint(...ids); }
    }`);
    module('onnxruntime-web', `import { appendFileSync, readFileSync } from 'node:fs';
      import { threadId } from 'node:worker_threads';
      const log = (kind) => appendFileSync(process.env.GHQCD_TEST_VECTOR_LOG, JSON.stringify({
        kind, pid: process.pid, threadId, phase: readFileSync(process.env.GHQCD_TEST_PHASE, 'utf8'),
      }) + '\\n');
      export const env = { wasm: {} };
      export class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
      export const InferenceSession = { async create() {
        log('load');
        const heartbeat = setInterval(() => log('alive'), 80);
        heartbeat.unref();
        return { inputMetadata: [], async run(feeds) {
          log('query');
          const n = feeds.input_ids.data.length;
          return { last_hidden_state: { dims: [1, n, 2], data: Float32Array.from({ length: n * 2 }, (_, i) => i % 2 ? 0 : 1) } };
        }, release() { clearInterval(heartbeat); } };
      } };`);
    writeFileSync(join(cache, `chunks-${MODEL.key}.json`), JSON.stringify([
      { key: 'fixture', path: repos[1], kind: 'readme', preview: 'a semantic fixture match' },
    ]));
    writeFileSync(join(cache, `vectors-${MODEL.key}.json`), JSON.stringify({ keys: ['fixture'], dim: 2 }));
    writeFileSync(join(cache, `vectors-${MODEL.key}.f32`), new Uint8Array(new Float32Array([1, 0]).buffer));
  }
  return { base, cache, shims, repos, env, bin: fileURLToPath(new URL('../../bin/ghqcd.mjs', import.meta.url)) };
}
