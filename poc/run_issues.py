# C: rank repos with index R (description + README) and R+I (+ issues), for Qwen3 and the lexical baseline.
# Rankings name private repos, so they stay in the cache; report_issues.py publishes aggregates only.
import hashlib, json, math, os, sys
from collections import Counter
import numpy as np
from common import ISSUES, load_queries, rank_repos, verify_manifest
from lexical import terms, vec

os.environ["HF_HUB_OFFLINE"] = "1"
LANGS = ["ja", "zh", "zh_nolatin"]
man = json.load(open(ISSUES / "manifest.json"))
for f in ["corpus.json", "queries_issue.json"]:
    assert man[f] == hashlib.sha256((ISSUES / f).read_bytes()).hexdigest(), f"{f} changed after freezing"
verify_manifest()

corpus = json.load(open(ISSUES / "corpus.json"))
queries = [q for q in load_queries() if q["kind"] != "name"] + json.load(open(ISSUES / "queries_issue.json"))
# One text per (repo, part): R parts are the repo text as in run.py's c1; I parts are one per issue.
R = [(d["id"], "\n\n".join(x for x in [d["id"], d["description"], d["readme"]] if x)) for d in corpus]
I = [(d["id"], f'{i["title"]}\n\n{i["body"]}') for d in corpus for i in d["issues"]]
INDEXES = {"R": R, "RI": R + I}
res = dict(runs={}, index={})

# Lexical: one TF-IDF document per repo (all its parts concatenated), as lexical.py does per repo.
for iname, parts in INDEXES.items():
    texts = {}
    for o, t in parts: texts[o] = texts.get(o, "") + "\n\n" + t
    ids = sorted(texts)
    tfs = [Counter(terms(texts[i])) for i in ids]
    df = Counter(k for c in tfs for k in c)
    idf = {k: math.log(len(ids) / n) + 1 for k, n in df.items()}
    dvs = [vec(c, idf) for c in tfs]
    for lang in LANGS:
        out = []
        for q in queries:
            if not q.get(lang): continue
            qv = vec(Counter(terms(q[lang])), idf)
            s = [(i, float(sum(w * dv.get(k, 0.0) for k, w in qv.items()))) for i, dv in zip(ids, dvs)]
            out.append(dict(id=q["id"], ranking=sorted(s, key=lambda kv: (-kv[1], kv[0]))))
        res["runs"][f"lexical/{iname}/{lang}"] = out

# Qwen3: same load / chunking / prompts as run.py.
from sentence_transformers import SentenceTransformer
from huggingface_hub import snapshot_download
from models import MODELS, ALLOW, IGNORE
m = MODELS["qwen3-0.6b"]
path = snapshot_download(m["repo"], revision=m["rev"], local_files_only=True,
                         allow_patterns=ALLOW + ["model.safetensors"], ignore_patterns=IGNORE)
model = SentenceTransformer(path, device="mps", local_files_only=True, trust_remote_code=False,
                            model_kwargs={"torch_dtype": "float32", "use_safetensors": True})
model.max_seq_length = MAX = 512
tok = model.tokenizer
ntok = lambda t: len(tok(t, add_special_tokens=True)["input_ids"])
enc = lambda texts, tpl: model.encode([tpl.format(t) for t in texts], batch_size=4, normalize_embeddings=True,
                                      convert_to_numpy=True, show_progress_bar=False).astype(np.float32)


def chunk(text):
    budget = MAX - ntok(m["d"].format(""))
    out, cur = [], ""
    for para in [p.strip() for p in text.split("\n\n") if p.strip()]:
        if ntok(para) > budget:
            if cur: out.append(cur); cur = ""
            ids = tok(para, add_special_tokens=False)["input_ids"]
            for i in range(0, len(ids), budget - 64):
                out.append(tok.decode(ids[i:i + budget]))
                if i + budget >= len(ids): break
            continue
        cand = f"{cur}\n\n{para}" if cur else para
        if ntok(cand) <= budget: cur = cand
        else: out.append(cur); cur = para
    if cur: out.append(cur)
    return out or [text]


vecs = {}
for name, parts in [("R", R), ("I", I)]:
    chunks, owner = [], []
    for o, t in parts:
        for c in chunk(t): chunks.append(c); owner.append(o)
    assert max(ntok(m["d"].format(c)) for c in chunks) <= MAX
    vecs[name] = (enc(chunks, m["d"]), owner)
    res["index"][name] = dict(chunks=len(chunks))
idx = {"R": vecs["R"], "RI": (np.vstack([vecs["R"][0], vecs["I"][0]]), vecs["R"][1] + vecs["I"][1])}
for lang in LANGS:
    qs = [q for q in queries if q.get(lang)]
    qv = enc([q[lang] for q in qs], m["q"])
    for iname, (dv, owner) in idx.items():
        res["runs"][f"qwen3/{iname}/{lang}"] = [dict(id=q["id"], ranking=rank_repos(v, dv, owner)) for q, v in zip(qs, qv)]
np.savez(ISSUES / "qwen3.npz", R=vecs["R"][0], I=vecs["I"][0])
p = ISSUES / "results.json"
p.write_text(json.dumps(res, ensure_ascii=False))
os.chmod(p, 0o600)
print("done", res["index"], file=sys.stderr)
