// Development-only evaluation. Reads an existing local index/model; no network or indexing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir, MODEL, loadEmbedder } from '../lib/search-index.mjs';
import { evaluate, chooseThreshold } from './semantic-metrics.mjs';

const dir = fileURLToPath(new URL('../docs/research/semantic-calibration/', import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const save = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n');
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const extra = ['prospective', 'confirmation'].find((mode) => process.argv.includes(`--${mode}`));
const gold = read(extra ? `${extra}-queries.json` : 'queries.json'), manifest = read('corpus.json');
const scoreFile = extra ? `${extra}-scores.json` : 'scores.json';
const queries = gold.groups.flatMap((g) => (gold.lengths ?? ['short', 'long']).flatMap((length) => ['zh', 'ja', 'en'].map((language, i) => ({
  id: `${g.id}.${language}.${length}`, group: g.id, split: g.split, language, length,
  query: g[length][i], relevant: g.relevant.map((r) => `github.com/${r}`),
})))).concat((gold.regressions ?? []).map((q) => ({ ...q, relevant: q.relevant.map((r) => `github.com/${r}`) })));
const corpus = manifest.repositories.map((r) => r.slug);
assert.equal(new Set(queries.map((q) => q.id)).size, queries.length);
for (const q of queries) for (const r of q.relevant) assert.ok(corpus.includes(r), `${q.id}: unknown target ${r}`);

if (process.argv.includes('--measure')) {
  assert.equal(manifest.modelKey, MODEL.key);
  const cache = cacheDir();
  const repos = JSON.parse(readFileSync(join(cache, 'index.json'), 'utf8')).repos;
  const chunks = JSON.parse(readFileSync(join(cache, `chunks-${MODEL.key}.json`), 'utf8'));
  const meta = JSON.parse(readFileSync(join(cache, `vectors-${MODEL.key}.json`), 'utf8'));
  const buf = readFileSync(join(cache, `vectors-${MODEL.key}.f32`));
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  assert.ok(Number.isInteger(meta.dim) && meta.dim > 0, 'invalid vector dimension');
  assert.ok(data.length >= meta.keys.length * meta.dim, 'truncated vector rows');
  const row = new Map(meta.keys.map((key, i) => [key, i]));
  const repoAt = new Map();
  for (const [i, frozen] of manifest.repositories.entries()) {
    const pair = Object.entries(repos).find(([, r]) => r.slug === frozen.slug);
    assert.ok(pair, `missing ${frozen.slug}`);
    const [path, r] = pair;
    assert.equal(hash([r.name, r.description, r.readme, r.issues]), frozen.documentHash, `changed corpus: ${frozen.slug}`);
    assert.deepEqual(chunks.filter((c) => c.path === path).map((c) => c.key), frozen.chunkKeys, `changed chunks: ${frozen.slug}`);
    repoAt.set(path, i);
  }
  const selected = chunks.filter((c) => repoAt.has(c.path));
  assert.ok(selected.every((c) => row.has(c.key)), 'public vectors are incomplete');
  const emb = await loadEmbedder({ threads: 1 });
  const scores = [];
  try {
    for (const [i, q] of queries.entries()) {
      const vector = await emb.embedQuery(q.query);
      assert.equal(vector.length, meta.dim);
      const best = Array(corpus.length).fill(-1);
      for (const c of selected) {
        let score = 0;
        for (let j = 0, o = row.get(c.key) * meta.dim; j < meta.dim; j++) score += vector[j] * data[o + j];
        if (c.kind === 'issue') score -= MODEL.issuePenalty;
        assert.ok(Number.isFinite(score), 'non-finite cosine score');
        const k = repoAt.get(c.path);
        best[k] = Math.max(best[k], score);
      }
      scores.push(best);
      if ((i + 1) % 24 === 0) console.error(`measured ${i + 1}/${queries.length}`);
    }
  } finally { await emb.release(); }
  // Compact numeric rows; no document or issue text is copied into the artifact.
  const snapshot = { modelKey: MODEL.key, queryPrompt: MODEL.queryPrompt, issuePenalty: MODEL.issuePenalty,
    nodeVersion: process.version, measuredAt: new Date().toISOString(),
    queriesHash: hash(gold), corpusHash: hash(manifest), corpus, queries, scores };
  writeFileSync(join(dir, scoreFile), JSON.stringify(snapshot) + '\n');
}

const snapshot = read(scoreFile);
assert.equal(snapshot.queriesHash, hash(gold), 'queries changed after measurement');
assert.equal(snapshot.corpusHash, hash(manifest), 'corpus changed after measurement');
assert.equal(snapshot.modelKey, MODEL.key);
assert.equal(snapshot.queryPrompt, MODEL.queryPrompt);
assert.equal(snapshot.issuePenalty, MODEL.issuePenalty);
assert.deepEqual(snapshot.queries, queries, 'score rows do not match frozen queries');
assert.deepEqual(snapshot.corpus, corpus, 'score columns do not match frozen corpus');
assert.equal(snapshot.scores.length, queries.length, 'missing score rows');
assert.ok(snapshot.scores.every((row) => row.length === corpus.length && row.every(Number.isFinite)), 'invalid score matrix');
if (extra) {
  const policy = read('selection.json');
  const report = { queryCount: queries.length, threshold: policy.threshold, shortThreshold: policy.shortThreshold, maxGap: policy.maxGap,
    baseline: evaluate(snapshot, 0.45, extra),
    chosen: evaluate(snapshot, policy.threshold, extra, policy.maxGap ?? Infinity, policy.shortThreshold) };
  save(`${extra}-report.json`, report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const unconstrained = chooseThreshold(snapshot);
// Coarse floors avoid fitting 0.410017 exactly; a positive gap permits close runners-up.
const floors = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const shortFloors = [0.3, 0.35, 0.4, 0.45];
const gaps = Array.from({ length: 20 }, (_, i) => (i + 1) / 100);
const chosen = chooseThreshold(snapshot, floors, gold.requiredRegressionIds, gaps, shortFloors);
// Freeze the decision before computing holdout metrics.
save('selection.json', { queriesHash: snapshot.queriesHash, corpusHash: snapshot.corpusHash,
  scoresHash: hash(snapshot.scores), modelKey: MODEL.key,
  threshold: chosen.threshold, shortThreshold: chosen.shortThreshold, maxGap: Number.isFinite(chosen.maxGap) ? chosen.maxGap : null, calibration: chosen.metrics,
  candidateFloors: floors, candidateShortFloors: shortFloors, candidateMaxGaps: gaps,
  selectionRule: 'Maximize calibration micro F1; require known Chinese regressions. NFKC short query: <=12 Unicode characters or ASCII <=3 words. Coarse floors, positive gaps permit close runners-up. Tie: precision, higher long floor, higher short floor, smaller gap.',
  unconstrainedThreshold: unconstrained.threshold, requiredRegressionIds: gold.requiredRegressionIds });
const report = {
  corpusSize: corpus.length, queryCount: queries.length,
  baseline: Object.fromEntries(['calibration', 'holdout', 'regression'].map((s) => [s, evaluate(snapshot, 0.45, s)])),
  chosen: { threshold: chosen.threshold, shortThreshold: chosen.shortThreshold, maxGap: Number.isFinite(chosen.maxGap) ? chosen.maxGap : null,
    ...Object.fromEntries(['calibration', 'holdout', 'regression'].map((s) => [s, evaluate(snapshot, chosen.threshold, s, chosen.maxGap, chosen.shortThreshold)])) },
  fixedCutoffComparisons: [0.3, 0.35, 0.4, 0.41, 0.45, 0.5, 0.55, 0.6].map((threshold) => ({ threshold, ...evaluate(snapshot, threshold, 'calibration') })),
};
save('report.json', report);
console.log(JSON.stringify({ corpusSize: report.corpusSize, queryCount: report.queryCount, unconstrainedThreshold: unconstrained.threshold,
  baseline: report.baseline, chosen: report.chosen }, null, 2));
