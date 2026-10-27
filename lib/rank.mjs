// Keyword ranking for the one search window: which repositories match a query,
// and in what order. Pure: documents in, hits out. Meaning (vectors) and code
// hits are added below these by the caller.
//
// Doc: { key, slug, name, cloned, pushedAt?, description?, readme?, issues?: [{number,title,body}] }
// Hit: { key, slug, cloned, score, field, snippet, number? }

// The order the user asked for: name > description > README > issues > code.
const POINTS = { exact: 100, prefix: 90, name: 80, slug: 60, fuzzy: 40, description: 30, readme: 20, title: 12, body: 8 };
const FIELD = { exact: 'name', prefix: 'name', name: 'name', slug: 'slug', fuzzy: 'fuzzy', description: 'description', readme: 'readme', title: 'issue', body: 'issue' };

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// NFKC folds full-width letters from a Japanese IME (ＧｉｔＨｕｂ) into ASCII.
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase();

function subsequence(term, text) {
  let i = 0;
  for (const ch of text) if (ch === term[i] && ++i === term.length) return true;
  return false;
}

// About 100 characters around the first occurrence of `term` in `text`.
function around(text, term) {
  const t = flat(text), at = norm(t).indexOf(term);
  if (at < 0) return t.slice(0, 100);
  const start = Math.max(0, at - 40);
  return `${start ? '…' : ''}${t.slice(start, start + 100)}${start + 100 < t.length ? '…' : ''}`;
}

// The best place one term matches in one doc: { kind, points, snippet, number } or null.
function best(doc, term, single) {
  const name = norm(doc.name);
  if (name === term) return { kind: 'exact' };
  if (name.startsWith(term)) return { kind: 'prefix' };
  if (name.includes(term)) return { kind: 'name' };
  if (norm(doc.slug).includes(term)) return { kind: 'slug' };
  if (single && term.length > 1 && subsequence(term, name)) return { kind: 'fuzzy' };
  if (norm(doc.description).includes(term)) return { kind: 'description', snippet: around(doc.description, term) };
  if (norm(doc.readme).includes(term)) return { kind: 'readme', snippet: around(doc.readme, term) };
  for (const kind of ['title', 'body']) {
    const i = doc.issues?.find((x) => norm(x[kind]).includes(term));
    if (i) return { kind, number: i.number, snippet: `#${i.number} ${flat(i.title)}${kind === 'body' ? ` — ${around(i.body, term)}` : ''}` };
  }
  return null;
}

export function keywordRank(docs, query, { limit = 200 } = {}) {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = [];
  for (const doc of docs) {
    const found = terms.map((t) => best(doc, t, terms.length === 1));
    if (found.some((f) => !f)) continue;
    // The weakest term decides how the repository was found; the most
    // informative snippet (the first non-name one) explains it.
    const weakest = found.reduce((a, b) => (POINTS[b.kind] < POINTS[a.kind] ? b : a));
    const shown = found.find((f) => f.snippet) ?? {};
    hits.push({
      key: doc.key, slug: doc.slug, cloned: doc.cloned, pushedAt: doc.pushedAt ?? '',
      score: found.reduce((s, f) => s + POINTS[f.kind], 0),
      field: FIELD[weakest.kind],
      snippet: (shown.snippet ?? flat(doc.description)).slice(0, 120),
      ...(shown.number && { number: shown.number }),
    });
  }
  hits.sort((a, b) => b.score - a.score || b.cloned - a.cloned || b.pushedAt.localeCompare(a.pushedAt));
  return hits.slice(0, limit);
}

export const nameHits = (hits) => hits.filter((h) => h.field === 'name');
// What fzf matched before this window existed (the path): name, slug, subsequence.
export const pathHits = (hits) => hits.filter((h) => ['name', 'slug', 'fuzzy'].includes(h.field));

// `ghqcd <query>` lands without the window when the answer is clear: a unique
// clone found the way fzf matched the path before (name, slug, subsequence),
// unless a repository that is not cloned matches its name better; else, when
// no clone matches anywhere, a unique name among repositories that are not
// cloned. null: open the window.
export function landing(docs, query) {
  const cloned = keywordRank(docs.filter((d) => d.cloned), query);
  const here = pathHits(cloned);
  const far = nameHits(keywordRank(docs.filter((d) => !d.cloned), query));
  const doc = (hit) => docs.find((d) => d.key === hit.key);
  if (here.length === 1 && (!far.length || here[0].score >= far[0].score)) return doc(here[0]);
  // Never clone behind the user's back while a clone matches the words anywhere.
  if (!cloned.length && far.length === 1) return doc(far[0]);
  return null;
}

// What a result line says it matched, in the window's label column. `~` marks
// a meaning (vector) match; everything else matched the words typed. ASCII
// only: `≈` is East Asian ambiguous width and shifted the column under ja locales.
const LABEL = { name: 'name', fuzzy: 'name*', slug: 'path', description: 'desc', readme: 'readme', issue: 'issue' };
export const matchLabel = (hit) => (hit.via === 'meaning' ? `~${hit.kind === 'issue' ? 'issue' : 'readme'}`
  : hit.via === 'code' ? 'code' : LABEL[hit.field] ?? 'name');

// The lines around the first line that contains any of `terms`, for the
// preview: what matched, in place, with `around` lines either side.
export function matchContext(text, terms, around = 3) {
  const lines = String(text ?? '').split('\n');
  const i = lines.findIndex((l) => terms.some((t) => norm(l).includes(norm(t))));
  return i < 0 ? [] : lines.slice(Math.max(0, i - around), i + around + 1);
}
