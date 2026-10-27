# Real-model semantic cutoff calibration

2026-10-28. Qwen3-Embedding-0.6B fp16, pinned production ONNX/WASM model,
Node 24, one inference thread. No synthetic embeddings are used in these
measurements. Cached document vectors are reused; query vectors are computed
by the real production `loadEmbedder().embedQuery()` path.

## Selected policy

`lib/rank.mjs` owns the shared production/evaluation selector:

- NFKC-normalize for length classification. A short query is at most 12 Unicode
  characters, or ASCII with at most three whitespace-separated words.
- Short-query cosine floor: **0.40**. Other-query floor: **0.45**.
- Also require `score >= best repository score - 0.01`.
- Preserve the existing 20-result cap and README/issue max aggregation, with
  issue score penalty 0.1. Keyword and code ranking are unchanged.

The old global 0.45 rejects `加密 → fumi` at 0.410017 and `文件加密 → fumi`
at 0.439572, despite both ranking first. Simply lowering all queries to 0.41
hurts calibration F1 (56.9% → 45.9%) by returning many weakly related repos.
The final policy rescues short queries while narrowing other candidates to
the leading score cluster. It does not require reindexing or a model download.

## Corpus and judgments

- **35 public repositories / 201 cached README and issue chunks** from the
  user's actual index. Public visibility was checked with GitHub GraphQL
  `repository.isPrivate=false` before the corpus was frozen.
- Agent-authored functional relevance judgments. The original 205-query labels
  were independently reviewed by another agent before scoring. Challenge and
  confirmation labels were authored before scoring but independently reviewed
  afterward. These are **not human gold labels or an
  external benchmark**. Repository purpose/capability is relevant; merely
  mentioning another tool in Related links or using a dependency is not.
- Multiple relevant repositories are labeled where appropriate, including
  two Slack bot copies and overlapping repo/worktree tools.
- Artifacts contain public repository IDs, input hashes, queries and numeric
  scores. Document/issue bodies and the private corpus are not copied here.

`corpus.json` pins document hashes and chunk keys. `queries.json` has 34 intent
groups with Chinese/Japanese/English × short/long variants, plus one explicit
known regression: **205 queries**. Whole intent groups stay together:

- Calibration: 138 queries, including 30 no-answer queries.
- Original holdout: 60 queries, including 18 no-answer queries.
- Previously observed encryption regression: 7 queries. It is excluded from
  untouched holdout evidence and the calibration F1 objective; the two Chinese
  bug-case scores do constrain parameter acceptance.

The query/corpus manifest was committed at `78970eb` before inference.
Scores are frozen in `scores.json`; `selection.json` records the decision and
score/input hashes. Main score measurements are 205 × 35 repository scores.

## Selection and validation history

1. Sweep a single global cutoff from 0.00 to 1.00 by 0.01. Its unconstrained
   calibration F1 optimum is 0.55, which does not fix the observed encryption
   miss. Requiring the Chinese regressions lowers it to 0.41, with poor precision.
2. Compare positive max-gap values 0.01–0.20. A zero gap's pure top-1 solution
   has slightly higher training F1, but cannot retain close runners-up. Keep
   positive gaps for a repository search and use coarse floors to avoid fitting
   the observed 0.410017 score exactly.
3. A uniform 0.40 floor passed the original holdout but produced too many
   no-answer matches on 36 fresh phrasings. Keep those cases as a **challenge
   validation set**, rather than claiming they remain blind test evidence.
4. Select the final short/long policy by calibration micro F1 only, with long
   floors `[.45,.50,.55,.60,.65,.70]`, short floors `[.30,.35,.40,.45]` and gaps
   `.01–.20`. Require the known Chinese bug cases. Tie-break by precision,
   higher long floor, higher short floor, then smaller max gap.
5. Freeze the final parameters and **24 new-intent confirmation queries** at
   `6e5865d`, then compute their real-model scores once. These confirmation
   results were not used to revise the policy.

The original 60 holdout cases and the 36 fresh phrasings were inspected during
design revisions, so their final results are validation evidence, not a fully
blind test. Only the final 24 cases stayed unseen after final policy freeze.

## Results (micro metrics)

Precision = TP / (TP + FP), recall = TP / (TP + FN), F1 = 2TP / (2TP + FP + FN).
Predictions are returned repository sets after cutoff/max-gap/top-20 selection.
No-answer false positives count toward precision. These are **semantic-stage**
metrics, before keyword deduplication and code search.

| Set | Policy | Precision | Recall | F1 | TP / FP / FN |
| --- | --- | ---: | ---: | ---: | --- |
| Calibration, 138 | old 0.45 | 42.3% | 87.1% | 56.9% | 115 / 157 / 17 |
| Calibration, 138 | selected | 89.8% | 80.3% | 84.8% | 106 / 12 / 26 |
| Validation, 60 | old 0.45 | 35.5% | 90.5% | 51.0% | 38 / 69 / 4 |
| Validation, 60 | selected | 86.0% | 88.1% | 87.1% | 37 / 6 / 5 |
| Challenge, 36 | old 0.45 | 54.5% | 100.0% | 70.6% | 24 / 20 / 0 |
| Challenge, 36 | selected | 82.1% | 95.8% | 88.5% | 23 / 5 / 1 |
| **Final confirmation, 24** | **old 0.45** | **46.2%** | **100.0%** | **63.2%** | **12 / 14 / 0** |
| **Final confirmation, 24** | **selected** | **75.0%** | **100.0%** | **85.7%** | **12 / 4 / 0** |

No-answer queries returning at least one result: calibration **0/30**, original
validation **0/18**, challenge **4/12**, final confirmation **4/12**. The last
two rates equal the old 0.45 baseline: narrower ranking removes extra weak
hits but does not reliably detect every out-of-domain query.

Known encryption regression recall improves from 3/7 to 6/7. English `encrypt`
still falls below the short floor as a vector hit (0.393443); keyword description
matching already returns fumi for it. The two requested Chinese regressions
are both returned first by the actual production `meaningSearch()` over the
full current local index, not only by this public-slice evaluator.

## Reproduction

Recompute metrics and selection from the committed real-model score matrices
without loading a model, contacting a service, or reading the user's cache:

```sh
node scripts/calibrate-semantic.mjs
node scripts/calibrate-semantic.mjs --prospective
node scripts/calibrate-semantic.mjs --confirmation
node --test test/calibration.test.mjs test/rank.test.mjs
```

Add `--measure` to recompute embeddings against an **unchanged local cache**
containing the pinned model and the corpus snapshot. Changed document/chunk
hashes, incomplete vectors and nonfinite scores are rejected. This mode reads
the cache; it does not install a runtime, download a model or rebuild the index.
Independent embeddings cannot be recreated from hashes alone; the frozen
public source snapshot is not bundled. Matrix-level metric reproduction is
self-contained.

## Limits

This is a small, purpose-labeled local corpus. Many intents have one correct
repository; close real-world alternatives and private corpora may change the
precision/recall balance. The final confirmation has only 12 positive and 12
negative queries, with correlated translations. Percentages are descriptive
sample results, not general accuracy guarantees. Absolute cosine values are
not probabilities. Recalibrate after changing the model, prompt, chunking or
score aggregation.

All 24 final confirmation queries and all 36 challenge queries classify as
long queries. Their unseen confirmation evidence supports long-query filtering
and max-gap behavior; it does not establish unseen short-query generalization.
The lower short-query floor is supported by calibration, original validation
and the known real-world regression, with that limitation kept explicit.
