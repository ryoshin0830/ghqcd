# Semantic threshold calibration

> Execute inline with Superpowers executing-plans and verification-before-completion.

**Goal:** Select a precision/recall/F1 tradeoff using real pinned-model scores,
fix the known Chinese encryption miss, and retain keyword ranking and the 20-hit cap.

- [x] Verify descriptions are embedded and reproduce the original miss with the real model.
- [x] Verify public corpus visibility; keep private repository and issue text out of artifacts.
- [x] Define functional relevance labels before scoring, with short/long Chinese,
  Japanese and English queries. Have an independent reviewer check labels.
- [x] Keep observed encryption examples in a separate regression split; narrow
  worktree-list queries to remove a label ambiguity identified in review.
- [x] Freeze queries and corpus hashes in git before inference.
- [x] Measure all queries with the existing local Qwen3 fp16 model and vectors.
  Use the production cosine/max/issue-penalty/20-hit selection policy.
- [x] Sweep 0.00–1.00 by 0.01. Maximize micro F1 on calibration, breaking ties
  toward precision then the higher threshold. Require the two known Chinese
  encryption regressions to return fumi; report the unconstrained optimum too.
- [x] Freeze each selection before evaluation; label inspected validation honestly.
  Freeze the final policy and 24 previously unused intent queries before their inference.
  Report precision, recall, F1 and no-answer false-positive rate, including baseline 0.45.
- [x] Test metric arithmetic, split isolation, threshold boundaries and real-score regressions.
- [x] Apply the selected short/long floors and max-gap policy; update docs with scope and limitations.
- [x] Verify actual meaningSearch with the real model, run the full suite and clean-container E2E.
- [x] Finish code/results review and create a reviewable PR with measured evidence.

Labels are agent-authored functional judgments based on cached public docs,
checked by a separate agent. They are not an external human gold benchmark.
Metrics describe this 35-repository snapshot, not every user's private index.

## Executed result

A global lower cutoff reduced F1, so the final policy uses short floor 0.40,
long floor 0.45 and max gap 0.01. The final 24-query confirmation improves
precision 46.2% → 75.0%, recall stays 100%, and F1 63.2% → 85.7%.
The no-answer false-positive query count remains 4/12. Both Chinese encryption
regressions return fumi first through production meaningSearch over the full
local index. Public benchmark results and methodological limits are recorded
in `docs/research/semantic-calibration/README.md`.

Validation: 117/117 tests pass with zero skips in a clean network-disabled
Linux container, including five real-fzf PTY E2E cases. Host: 114 pass, three
fish skips. Metric replay requires no model or network. npm pack excludes
research datasets, scripts and tests. No vector rebuild or model download.

Reviewable PR: https://github.com/ryoshin0830/ghqcd/pull/6
