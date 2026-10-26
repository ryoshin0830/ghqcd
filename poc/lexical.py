# Lexical baseline: NFKC + casefold, ASCII word tokens + CJK character bigrams, TF-IDF cosine.
# Its zh->ja score shows how far shared kanji and Latin product names alone get you.
import json, math, re, unicodedata
from collections import Counter
from common import CORPORA, LANGS, load_corpora, load_queries, verify_manifest

CJK = re.compile(r"[぀-ヿ㐀-鿿豈-﫿]+")
WORD = re.compile(r"[a-z0-9]+")


def terms(text):
    t = unicodedata.normalize("NFKC", text).casefold()
    out = WORD.findall(t)
    for run in CJK.findall(t):
        out += [run[i:i + 2] for i in range(len(run) - 1)] or [run]
    return out


def vec(c, idf):
    v = {k: (1 + math.log(n)) * idf.get(k, 0.0) for k, n in c.items()}
    norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
    return {k: x / norm for k, x in v.items()}


verify_manifest()
corpora, queries = load_corpora(), load_queries()
res = dict(model="lexical", runs={})
for cname in CORPORA:
    docs = corpora[cname]
    tfs = [Counter(terms(d["text"])) for d in docs]
    df = Counter(k for c in tfs for k in c)
    idf = {k: math.log(len(docs) / n) + 1 for k, n in df.items()}
    dvs = [vec(c, idf) for c in tfs]
    for lang in LANGS:
        out = []
        for q in queries:
            if not q[lang]: continue
            qv = vec(Counter(terms(q[lang])), idf)
            scored = [(d["id"], sum(w * dv.get(k, 0.0) for k, w in qv.items())) for d, dv in zip(docs, dvs)]
            out.append(dict(id=q["id"], ranking=sorted(scored, key=lambda kv: (-kv[1], kv[0]))))
        res["runs"][f"{cname}/{lang}"] = out
json.dump(res, open("results/lexical.json", "w"), ensure_ascii=False, indent=1)
