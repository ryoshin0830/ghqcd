import { selectMeaningHits } from '../lib/rank.mjs';

export function evaluate(snapshot, threshold, split, maxGap = Infinity, shortThreshold = threshold) {
  let tp = 0, fp = 0, fn = 0, queries = 0, negatives = 0, negativeErrors = 0;
  for (const [i, q] of snapshot.queries.entries()) {
    if (q.split !== split) continue;
    queries++;
    const relevant = new Set(q.relevant);
    const hits = selectMeaningHits(snapshot.corpus.map((key, j) => ({ key, score: snapshot.scores[i][j] })), { query: q.query ?? '', minScore: threshold, shortMinScore: shortThreshold, maxGap });
    const correct = hits.filter((h) => relevant.has(h.key)).length;
    tp += correct; fp += hits.length - correct; fn += relevant.size - correct;
    if (!relevant.size) { negatives++; if (hits.length) negativeErrors++; }
  }
  return {
    queries, tp, fp, fn,
    precision: tp + fp ? tp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0,
    f1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : 0,
    negatives, negativeErrors, negativeFalsePositiveRate: negatives ? negativeErrors / negatives : 0,
  };
}

export function chooseThreshold(snapshot, thresholds = Array.from({ length: 101 }, (_, i) => i / 100), requiredIds = [], maxGaps = [Infinity], shortThresholds) {
  const required = new Set(requiredIds);
  for (const id of required) {
    const q = snapshot.queries.find((q) => q.id === id);
    if (!q) throw new Error(`Unknown required regression: ${id}`);
    if (q.split !== 'regression' || !q.relevant.length) throw new Error(`${id} must belong to regression with a relevant target`);
  }
  const candidates = [];
  for (const threshold of thresholds) for (const maxGap of maxGaps) for (const shortThreshold of shortThresholds ?? [threshold]) {
    if (shortThreshold > threshold) continue;
    const regressionsPass = snapshot.queries.every((q, i) => {
      if (!required.has(q.id)) return true;
      const keys = new Set(selectMeaningHits(snapshot.corpus.map((key, j) => ({ key, score: snapshot.scores[i][j] })), { query: q.query ?? '', minScore: threshold, shortMinScore: shortThreshold, maxGap }).map((h) => h.key));
      return q.relevant.every((key) => keys.has(key));
    });
    if (!regressionsPass) continue;
    const metrics = evaluate(snapshot, threshold, 'calibration', maxGap, shortThreshold);
    candidates.push({ threshold, shortThreshold, maxGap, metrics });
  }
  const best = candidates.sort((a, b) => b.metrics.f1 - a.metrics.f1 || b.metrics.precision - a.metrics.precision ||
    b.threshold - a.threshold || b.shortThreshold - a.shortThreshold || a.maxGap - b.maxGap)[0];
  if (!best) throw new Error('No candidate threshold satisfies the required regressions');
  return best;
}
