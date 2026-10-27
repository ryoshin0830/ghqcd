# Match labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every result line says what it matched (name / path / desc / readme / issue / code) and how (words, or ~ meaning), in an aligned label column; the preview shows the matched passage.

**Architecture:** A pure `matchLabel(hit)` and `matchContext(text, terms)` in `lib/rank.mjs`; `display()` and `preview()` in `bin/ghqcd.mjs` use them. The meta field (2nd tab field) becomes `<label>|<extra>`.

**Spec:** `docs/superpowers/specs/2026-10-27-match-labels-design.md`

## Global Constraints

- Labels exactly: `name`, `name*`, `path`, `desc`, `readme`, `issue`, `~readme`, `~issue`, `code`; padded to 7 columns.
- Meaning hits only carry `~`. Colors: words cyan (36), meaning magenta (35), code yellow (33); none under NO_COLOR.
- Order of results unchanged. fzf 0.38 compatible. No new dependencies.

## Review Focus

1. NO_COLOR: labels still distinguish words from meaning → test on `matchLabel` output (text only).
2. ctrl-o still opens the issue / file after the meta format change → manual tmux with an `open` shim.
3. CJK snippets keep the column aligned (labels are ASCII only) → manual at 80x24.

---

### Task 1: matchLabel and matchContext (lib/rank.mjs)

- Produces `matchLabel(hit) → string` (one of the labels) and `matchContext(text, terms, around = 3) → string[]` (the lines around the first line that contains any term; [] if none).
- Tests in `test/rank.test.mjs`: each field maps to its label (`fuzzy` → `name*`, `slug` → `path`, `description` → `desc`; via meaning + kind readme/issue → `~readme`/`~issue`; via code → `code`); `matchContext` returns lines i−3..i+3 for a match on line i and [] for no match, case- and width-insensitive (NFKC).
- RED → implement → GREEN → commit `feat: name what each result matched`.

### Task 2: display, header legend, meta, preview (bin/ghqcd.mjs)

- `display(hit)`: `<colored label padded to 7> <slug>[ · not cloned]  <snippet>`; name/path hits show the description dim.
- meta = `${label}|${#N | file:line}|${score}`; `urlOf` reads `#N` / `file:line` from the extra part.
- header line: `“<q>” · name path desc readme issue code: the words · ~: by meaning`.
- preview gets `{q}`: first `matched <field> by words|by meaning (similarity S)`, then `matchContext` of the README / issue body / `git grep -n -C 3` for local code, then description and recent commits.
- Verified in tmux (150, 80x24, 60, NO_COLOR); commit `feat: label results and show the matched passage`.
