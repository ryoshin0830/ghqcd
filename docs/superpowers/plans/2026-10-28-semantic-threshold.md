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
- [ ] Freeze queries and corpus hashes in git before inference.
- [ ] Measure all queries with the existing local Qwen3 fp16 model and vectors.
  Use the production cosine/max/issue-penalty/20-hit selection policy.
- [ ] Sweep 0.00–1.00 by 0.01. Maximize micro F1 on calibration, breaking ties
  toward precision then the higher threshold. Require the two known Chinese
  encryption regressions to return fumi; report the unconstrained optimum too.
- [ ] Freeze selection before evaluating untouched intent-group holdout results.
  Report precision, recall, F1 and no-answer false-positive rate, including baseline 0.45.
- [ ] Test metric arithmetic, split isolation, threshold boundaries and real-score regressions.
- [ ] Apply the selected single threshold; update docs with scope and limitations.
- [ ] Verify actual meaningSearch with the real model, run the full suite and clean-container E2E.
- [ ] Review code and evaluation artifacts, then create a reviewable PR with measured evidence.

Labels are agent-authored functional judgments based on cached public docs,
checked by a separate agent. They are not an external human gold benchmark.
Metrics describe this 35-repository snapshot, not every user's private index.
