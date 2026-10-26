# C: rank repos with index R (description + README) and RI (+ issues).
# usage: python run_issues.py <model|lexical>   -> ISSUES/results/<model>.json
#        python run_issues.py <model> --dump     -> ISSUES/dump/<model>.json (exact prompted texts, for node/embed.mjs)
#        python run_issues.py <model> --from <tag> -> score vectors node/embed.mjs wrote to ISSUES/dump/<tag>.f32
# Per query it keeps each repo's best README-chunk and best issue-chunk score apart ("split"),
# so report_issues.py can compare aggregation rules without re-embedding.
# Rankings name private repos, so they stay in the cache; report_issues.py publishes aggregates only.
import hashlib, json, math, os, sys
from collections import Counter
import numpy as np
from common import ISSUES, load_queries, verify_manifest

name = sys.argv[1]
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
res = dict(model=name, runs={}, split={}, index={})


def best(scores, owner):
    out = {}
    for o, x in zip(owner, scores): out[o] = max(out.get(o, -9.0), float(x))
    return out


def record(lang, qs, sR, sI):
    """sR/sI: per query, {repo: best score} for README parts and issue parts."""
    res["split"][lang] = [dict(id=q["id"], scores={r: [a[r], b.get(r)] for r in a}) for q, a, b in zip(qs, sR, sI)]
    for iname, f in [("R", lambda a, b, r: a[r]), ("RI", lambda a, b, r: max(a[r], b.get(r, -9.0)))]:
        res["runs"][f"{iname}/{lang}"] = [dict(id=q["id"], ranking=sorted(((r, f(a, b, r)) for r in a), key=lambda kv: (-kv[1], kv[0])))
                                          for q, a, b in zip(qs, sR, sI)]


if name == "lexical":
    # One TF-IDF document per repo and part set, as lexical.py does per repo.
    from lexical import terms, vec

    def tfidf(parts):
        texts = {}
        for o, t in parts: texts[o] = texts.get(o, "") + "\n\n" + t
        tfs = {o: Counter(terms(t)) for o, t in texts.items()}
        df = Counter(k for c in tfs.values() for k in c)
        idf = {k: math.log(len(tfs) / n) + 1 for k, n in df.items()}
        return {o: vec(c, idf) for o, c in tfs.items()}, idf

    # Lexical has no part split: R ranks the README texts, RI the README + issue texts concatenated per repo.
    for iname, (dv, idf) in [("R", tfidf(R)), ("RI", tfidf(R + I))]:
        for lang in LANGS:
            res["runs"][f"{iname}/{lang}"] = []
            for q in [q for q in queries if q.get(lang)]:
                qv = vec(Counter(terms(q[lang])), idf)
                s = {o: float(sum(w * v.get(k, 0.0) for k, w in qv.items())) for o, v in dv.items()}
                res["runs"][f"{iname}/{lang}"].append(dict(id=q["id"], ranking=sorted(s.items(), key=lambda kv: (-kv[1], kv[0]))))
else:
    from sentence_transformers import SentenceTransformer
    from huggingface_hub import snapshot_download
    from models import MODELS, ALLOW, WEIGHTS, IGNORE
    m = MODELS[name]
    path = snapshot_download(m["repo"], revision=m["rev"], local_files_only=True,
                             allow_patterns=ALLOW + WEIGHTS.get(name, ["model.safetensors"]), ignore_patterns=IGNORE)
    kw = dict(device="mps", local_files_only=True, trust_remote_code=False, model_kwargs={"torch_dtype": "float32"})
    if name == "gemma2": kw["config_kwargs"] = {"vision_config": None, "audio_config": None}
    if name != "bge-m3": kw["model_kwargs"]["use_safetensors"] = True
    model = SentenceTransformer(path, **kw)
    model.max_seq_length = MAX = 512
    tok = model.tokenizer
    ntok = lambda t: len(tok(t, add_special_tokens=True)["input_ids"])
    enc = lambda texts, tpl: model.encode([tpl.format(t) for t in texts], batch_size=4, normalize_embeddings=True,
                                          convert_to_numpy=True, show_progress_bar=False).astype(np.float32)
    DUMP = ISSUES / "dump"
    if "--dump" in sys.argv or "--from" in sys.argv:
        dump = [] if "--dump" in sys.argv else json.load(open(DUMP / f"{name}.json"))["texts"]
        if "--from" in sys.argv:
            tag = sys.argv[sys.argv.index("--from") + 1]
            name = f"{name}@{tag}"
            V = np.fromfile(DUMP / f"{tag}.f32", dtype=np.float32).reshape(len(dump), -1)
            row = {t: i for i, t in enumerate(dump)}
            enc = lambda texts, tpl: V[[row[tpl.format(t)] for t in texts]]
        else:
            def enc(texts, tpl, _dim=m["dim"]):
                dump.extend(tpl.format(t) for t in texts)
                return np.zeros((len(texts), _dim), np.float32)

    def chunk(text):  # same rule as run.py
        budget = MAX - ntok(m["d"].format(""))
        out, cur = [], ""
        for para in [p.strip() for p in text.split("\n\n") if p.strip()]:
            if ntok(para) > budget:
                if cur: out.append(cur); cur = ""
                ids = tok(para, add_special_tokens=False)["input_ids"]
                for i in range(0, len(ids), budget - 64):
                    k = budget  # decode -> re-encode can grow (sentencepiece models); shrink until it fits
                    while ntok(m["d"].format(tok.decode(ids[i:i + k]))) > MAX: k -= 8
                    out.append(tok.decode(ids[i:i + k]))
                    if i + budget >= len(ids): break
                continue
            cand = f"{cur}\n\n{para}" if cur else para
            if ntok(cand) <= budget: cur = cand
            else: out.append(cur); cur = para
        if cur: out.append(cur)
        return out or [text]

    vecs = {}
    for pname, parts in [("R", R), ("I", I)]:
        chunks, owner = [], []
        for o, t in parts:  # env ISSUE_CHUNKS=1 keeps only the first chunk of each issue
            cs = chunk(t)
            if pname == "I" and os.environ.get("ISSUE_CHUNKS"): cs = cs[:int(os.environ["ISSUE_CHUNKS"])]
            for c in cs: chunks.append(c); owner.append(o)
        assert max(ntok(m["d"].format(c)) for c in chunks) <= MAX
        vecs[pname] = (enc(chunks, m["d"]), owner)
        res["index"][pname] = dict(chunks=len(chunks))
    for lang in LANGS:
        qs = [q for q in queries if q.get(lang)]
        qv = enc([q[lang] for q in qs], m["q"])
        sR = [best(vecs["R"][0] @ v, vecs["R"][1]) for v in qv]
        sI = [best(vecs["I"][0] @ v, vecs["I"][1]) for v in qv]
        record(lang, qs, sR, sI)

if "--dump" in sys.argv:
    DUMP.mkdir(exist_ok=True, mode=0o700)
    p = DUMP / f"{name}.json"
    p.write_text(json.dumps(dict(texts=list(dict.fromkeys(dump))), ensure_ascii=False))
    os.chmod(p, 0o600)
    sys.exit(print(name, "dumped", len(set(dump)), file=sys.stderr))
(ISSUES / "results").mkdir(exist_ok=True, mode=0o700)
if os.environ.get("ISSUE_CHUNKS"): name += f'+i{os.environ["ISSUE_CHUNKS"]}'
p = ISSUES / "results" / f"{name}.json"
p.write_text(json.dumps(res, ensure_ascii=False))
os.chmod(p, 0o600)
print(name, "done", res["index"], file=sys.stderr)
