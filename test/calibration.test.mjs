import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluate, chooseThreshold } from '../scripts/semantic-metrics.mjs';
import { MEANING_MIN_SCORE, MEANING_SHORT_MIN_SCORE, MEANING_MAX_GAP, selectMeaningHits } from '../lib/rank.mjs';
import { MODEL } from '../lib/search-index.mjs';

const corpus = ['a', 'b'];
const queries = [
  { id: 'positive', split: 'calibration', relevant: ['a'] },
  { id: 'negative', split: 'calibration', relevant: [] },
  { id: 'held', split: 'holdout', relevant: ['b'] },
];
const scores = [[0.4, 0.3], [0.35, 0.2], [0.9, 0.1]];

test('retrieval metrics count returned repositories and no-answer false positives', () => {
  const m = evaluate({ corpus, queries, scores }, 0.3, 'calibration');
  assert.equal(m.tp, 1);
  assert.equal(m.fp, 2);
  assert.equal(m.fn, 0);
  assert.equal(m.precision, 1 / 3);
  assert.equal(m.recall, 1);
  assert.equal(m.f1, 0.5);
  assert.equal(m.negativeFalsePositiveRate, 1);
});

test('selection uses calibration only, regardless of holdout scores', () => {
  const snapshot = { corpus, queries, scores };
  assert.equal(chooseThreshold(snapshot, [0.3, 0.35, 0.4, 0.45]).threshold, 0.4);
  const changed = { ...snapshot, scores: [...scores.slice(0, 2), [0, 1]] };
  assert.equal(chooseThreshold(changed, [0.3, 0.35, 0.4, 0.45]).threshold, 0.4);
});

test('equal F1 prefers precision, then the higher threshold for identical hits', () => {
  const snapshot = { corpus, queries: [
    { id: 'one', split: 'calibration', relevant: ['a'] },
    { id: 'two', split: 'calibration', relevant: ['b'] },
  ], scores: [[0.9, 0.4], [0.4, 0.4]] };
  assert.equal(evaluate(snapshot, 0.3, 'calibration').f1, evaluate(snapshot, 0.8, 'calibration').f1);
  const best = chooseThreshold(snapshot, [0.3, 0.8, 0.85]);
  assert.equal(best.metrics.precision, 1);
  assert.equal(best.threshold, 0.85);
});

test('empty predictions use zero precision/recall/F1, never NaN', () => {
  const m = evaluate({ corpus, queries, scores }, 1, 'calibration');
  assert.deepEqual([m.precision, m.recall, m.f1], [0, 0, 0]);
  assert.equal(m.negativeFalsePositiveRate, 0);
});

test('known regressions constrain acceptance without using holdout answers', () => {
  const snapshot = { corpus, queries: [...queries, { id: 'known', split: 'regression', relevant: ['a'] }], scores: [...scores, [0.3, 0.1]] };
  assert.equal(chooseThreshold(snapshot, [0.3, 0.4], ['known']).threshold, 0.3);
  assert.throws(() => chooseThreshold(snapshot, [0.4], ['known']), /No candidate/);
  assert.throws(() => chooseThreshold(snapshot, [0.3], ['typo']), /Unknown required regression/);
  assert.throws(() => chooseThreshold(snapshot, [0.3], ['held']), /must belong to regression/);
});

const artifact = (name) => JSON.parse(readFileSync(new URL(`../docs/research/semantic-calibration/${name}`, import.meta.url), 'utf8'));
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

test('the calibrated production policy accepts the real-model Chinese encryption regressions', () => {
  const snapshot = artifact('scores.json'), policy = artifact('selection.json');
  assert.equal(snapshot.modelKey, MODEL.key);
  assert.equal(snapshot.queryPrompt, MODEL.queryPrompt);
  assert.equal(snapshot.issuePenalty, MODEL.issuePenalty);
  assert.equal(snapshot.queriesHash, hash(artifact('queries.json')));
  assert.equal(snapshot.corpusHash, hash(artifact('corpus.json')));
  assert.equal(policy.scoresHash, hash(snapshot.scores));
  assert.equal(MEANING_MIN_SCORE, policy.threshold);
  assert.equal(MEANING_SHORT_MIN_SCORE, policy.shortThreshold);
  assert.equal(MEANING_MAX_GAP, policy.maxGap);
  for (const id of policy.requiredRegressionIds) {
    const i = snapshot.queries.findIndex((q) => q.id === id);
    assert.ok(i >= 0);
    const hits = snapshot.corpus.map((key, j) => ({ key, score: snapshot.scores[i][j] }));
    assert.ok(selectMeaningHits(hits, { query: snapshot.queries[i].query }).some((h) => h.key === 'github.com/ryoshin0830/fumi'), id);
  }
});
