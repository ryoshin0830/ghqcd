// The ranker behind the one search window. Pure: documents in, hits out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordRank, nameHits, pathHits, landing, matchLabel, matchContext } from '../lib/rank.mjs';

const doc = (name, extra = {}) => ({
  key: `/r/${name}`, slug: `github.com/alice/${name}`, name, cloned: true, ...extra,
});
const order = (hits) => hits.map((h) => h.slug.split('/').pop());

test('an exact name beats a README that mentions it', () => {
  const hits = keywordRank([doc('other', { readme: 'see lj for details' }), doc('lj')], 'lj');
  assert.deepEqual(order(hits), ['lj', 'other']);
  assert.equal(hits[0].field, 'name');
});

test('fields weigh name > description > README > issue title > issue body', () => {
  const docs = [
    doc('d', { issues: [{ number: 4, title: 'x', body: 'about zebra' }] }),
    doc('b', { readme: 'zebra' }),
    doc('c', { issues: [{ number: 3, title: 'zebra crossing', body: '' }] }),
    doc('a', { description: 'a zebra tool' }),
  ];
  assert.deepEqual(order(keywordRank(docs, 'zebra')), ['a', 'b', 'c', 'd']);
  assert.equal(keywordRank(docs, 'zebra').find((h) => h.slug.endsWith('/c')).number, 3);
});

test('every term must match somewhere, in any field', () => {
  const docs = [
    doc('one', { description: 'sandbox', issues: [{ number: 5, title: '自動で回収する', body: '' }] }),
    doc('two', { description: 'sandbox only' }),
  ];
  assert.deepEqual(order(keywordRank(docs, 'sandbox 回収')), ['one']);
});

test('matching ignores case and handles Japanese text', () => {
  const hits = keywordRank([doc('short-url', { description: 'ショートURL・ファイル転送' })], 'url');
  assert.equal(hits[0].field, 'name');
  const jp = keywordRank([doc('s', { description: 'ショートURL・ファイル転送' })], 'ファイル');
  assert.equal(jp[0].field, 'description');
});

test('a single term may match the name as a subsequence; several terms may not', () => {
  const docs = [doc('ghqcd-zhja-poc')];
  assert.equal(keywordRank(docs, 'ghqzh')[0].field, 'fuzzy');
  assert.equal(keywordRank(docs, 'gq zj').length, 0);
});

test('equal scores put clones first, then the most recently pushed', () => {
  const docs = [
    doc('old', { cloned: false, description: 'cli', pushedAt: '2026-01-01T00:00:00Z' }),
    doc('new', { cloned: false, description: 'cli', pushedAt: '2026-09-01T00:00:00Z' }),
    doc('here', { description: 'cli', pushedAt: '2025-01-01T00:00:00Z' }),
  ];
  assert.deepEqual(order(keywordRank(docs, 'cli')), ['here', 'new', 'old']);
});

test('a README hit carries a short snippet around the match', () => {
  const readme = `${'intro '.repeat(80)}the needle is here ${'outro '.repeat(80)}`;
  const [hit] = keywordRank([doc('x', { readme })], 'needle');
  assert.equal(hit.field, 'readme');
  assert.match(hit.snippet, /needle/);
  assert.ok(hit.snippet.length <= 120, hit.snippet.length);
});

test('nameHits keeps only hits found by name', () => {
  const hits = keywordRank([doc('lj'), doc('other', { readme: 'lj' })], 'lj');
  assert.deepEqual(order(nameHits(hits)), ['lj']);
});

test('pathHits keeps hits found by name, slug, or subsequence: what fzf matched before', () => {
  const docs = [doc('alchemy', { slug: 'ghe.example.com/hosting/alchemy' }), doc('notes', { readme: 'hosting' })];
  assert.deepEqual(order(pathHits(keywordRank(docs, 'hosting/alc'))), ['alchemy']);
  assert.deepEqual(order(pathHits(keywordRank(docs, 'hosting'))), ['alchemy']);
});

test('full-width letters from a Japanese IME match, both in the query and in the text', () => {
  const hits = keywordRank([doc('tool', { description: 'ＧｉｔＨｕｂ helper' }), doc('github-x')], 'ｇｉｔｈｕｂ');
  assert.deepEqual(order(hits), ['github-x', 'tool']);
});

test('landing: a unique clone lands, else a unique name among repositories not cloned', () => {
  const far = (name) => doc(name, { key: `github.com/alice/${name}`, cloned: false });
  assert.equal(landing([doc('api'), doc('web')], 'api').key, '/r/api');
  assert.equal(landing([doc('web'), far('lj')], 'lj').key, 'github.com/alice/lj');
  assert.equal(landing([doc('api'), doc('api-x')], 'api'), null, 'two clones: open the window');
  assert.equal(landing([doc('load-json'), far('lj')], 'lj'), null, 'a weak subsequence clone must not hide an exact name');
  assert.equal(landing([doc('api', { description: 'Billing API for the shop' }), far('billing')], 'billing'), null,
    'a clone matched by its description: open the window, never clone behind the user\'s back');
  assert.equal(landing([doc('web'), far('docs-site')], 'docs-site').key, 'github.com/alice/docs-site', 'no clone matches: clone it');
});

test('matchLabel names the field and, with ~, a meaning match', () => {
  const cases = [
    [{ field: 'name' }, 'name'], [{ field: 'fuzzy' }, 'name*'], [{ field: 'slug' }, 'path'],
    [{ field: 'description' }, 'desc'], [{ field: 'readme' }, 'readme'], [{ field: 'issue' }, 'issue'],
    [{ via: 'meaning', kind: 'readme' }, '~readme'], [{ via: 'meaning', kind: 'issue' }, '~issue'],
    [{ via: 'code' }, 'code'],
  ];
  for (const [hit, label] of cases) assert.equal(matchLabel(hit), label, JSON.stringify(hit));
});

test('matchContext returns the lines around the first matching line', () => {
  const text = ['a', 'b', 'c', 'd', 'the ＮＥＥＤＬＥ', 'f', 'g', 'h', 'i'].join('\n');
  assert.deepEqual(matchContext(text, ['needle']), ['b', 'c', 'd', 'the ＮＥＥＤＬＥ', 'f', 'g', 'h']);
  assert.deepEqual(matchContext('one\ntwo', ['zzz']), []);
  assert.deepEqual(matchContext('x needle', ['needle'], 1), ['x needle']);
});
