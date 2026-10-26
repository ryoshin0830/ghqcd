# Evaluate one embedding model on the frozen corpora and queries.
# usage: python run.py <profile>            -> results/<profile>.json
#        python run.py <profile> --cold      -> one process-start-to-first-result timing (stdout JSON)
import json, os, resource, sys, time
T0 = time.perf_counter()
import numpy as np
from pathlib import Path
from common import CACHE, CORPORA, LANGS, load_corpora, load_queries, rank_repos, verify_manifest

name = sys.argv[1]
cold = "--cold" in sys.argv
os.environ["HF_HUB_OFFLINE"] = "1"  # inference never touches the network
from sentence_transformers import SentenceTransformer
from models import MODELS, ALLOW, WEIGHTS, IGNORE

m = MODELS[name]
dl = json.load(open("results/download.json"))[name]
from huggingface_hub import snapshot_download
MODEL_PATH = snapshot_download(m["repo"], revision=m["rev"], local_files_only=True,
                               allow_patterns=ALLOW + WEIGHTS.get(name, ["model.safetensors"]), ignore_patterns=IGNORE)
MAX_TOKENS = 512
DEVICE = "mps"


def load():
    kw = dict(device=DEVICE, local_files_only=True, trust_remote_code=False,
              model_kwargs={"torch_dtype": "float32"})
    if name == "gemma2":  # text-only: drop the unused vision/audio towers
        kw["config_kwargs"] = {"vision_config": None, "audio_config": None}
    if name != "bge-m3":  # bge-m3 ships only pytorch_model.bin (read via torch weights_only)
        kw["model_kwargs"]["use_safetensors"] = True
    model = SentenceTransformer(MODEL_PATH, **kw)
    model.max_seq_length = MAX_TOKENS
    return model


def encode(model, texts, template, batch_size=4):
    v = model.encode([template.format(t) for t in texts], batch_size=batch_size,
                     normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    return v.astype(np.float32)


if cold:
    model = load()
    vecs = np.load(CACHE / f"{name}.npz")
    q = load_queries()[0]["zh"]
    qv = encode(model, [q], m["q"])
    rank_repos(qv[0], vecs["c2_vecs"], list(vecs["c2_owner"]))
    print(json.dumps({"process_to_first_result_s": time.perf_counter() - T0}))
    sys.exit()

verify_manifest()
t = time.perf_counter(); model = load(); load_s = time.perf_counter() - t
tok = model.tokenizer

# The prompts we pass must be the ones the model ships, where it ships any.
st_prompts = getattr(model, "prompts", {}) or {}
if name == "qwen3-0.6b":
    assert m["q"] == st_prompts["query"] + "{}" and st_prompts["document"] == "", st_prompts
if name == "gemma2":
    assert m["q"] == st_prompts["query"] + "{}", st_prompts
    assert m["d"] == st_prompts["document"] + "{}", st_prompts
if name.startswith("harrier"):
    assert m["q"] == st_prompts["web_search_query"] + "{}" and m["d"] == "{}", st_prompts
if name.startswith("granite"):
    assert st_prompts == {"query": "", "document": ""} and m["q"] == m["d"] == "{}", st_prompts


def ntok(text):
    return len(tok(text, add_special_tokens=True)["input_ids"])


def chunk(text, template):
    """Pack paragraphs up to the token budget; split only oversized paragraphs, with overlap.
    The budget includes the prompt and special tokens, so nothing is truncated."""
    budget = MAX_TOKENS - ntok(template.format(""))
    out, cur = [], ""
    for para in [p.strip() for p in text.split("\n\n") if p.strip()]:
        if ntok(para) > budget:
            if cur: out.append(cur); cur = ""
            ids = tok(para, add_special_tokens=False)["input_ids"]
            step = budget - 64
            for i in range(0, len(ids), step):
                out.append(tok.decode(ids[i:i + budget]))
                if i + budget >= len(ids): break
            continue
        cand = f"{cur}\n\n{para}" if cur else para
        if ntok(cand) <= budget: cur = cand
        else: out.append(cur); cur = para
    if cur: out.append(cur)
    return out or [text]


corpora = load_corpora()
queries = load_queries()
res = dict(model=name, repo=m["repo"], revision=m["rev"], device=DEVICE, dtype="float32", batch_size=4,
           max_tokens=MAX_TOKENS, load_s=load_s, download=dl, checks={}, index={}, runs={})
CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
saved = {}
for cname in CORPORA:
    docs = corpora[cname]
    chunks, owner = [], []
    for d in docs:
        for c in chunk(d["text"], m["d"]):
            chunks.append(c); owner.append(d["id"])
    lens = [ntok(m["d"].format(c)) for c in chunks]
    assert max(lens) <= MAX_TOKENS, max(lens)
    t = time.perf_counter(); dv = encode(model, chunks, m["d"]); idx_s = time.perf_counter() - t
    res["index"][cname] = dict(chunks=len(chunks), tokens=sum(lens), max_tokens=max(lens), seconds=idx_s,
                               chunks_per_repo=max(owner.count(i) for i in set(owner)))
    saved[f"{cname}_vecs"] = dv; saved[f"{cname}_owner"] = np.array(owner)
    for lang in LANGS:
        qs = [q for q in queries if q[lang]]
        qv = encode(model, [q[lang] for q in qs], m["q"])
        res["runs"][f"{cname}/{lang}"] = [dict(id=q["id"], ranking=rank_repos(v, dv, owner)) for q, v in zip(qs, qv)]
        if cname == "c2" and lang == "zh":  # correctness checks on one representative batch
            single = encode(model, [q[lang] for q in qs], m["q"], batch_size=1)
            norms = np.linalg.norm(qv, axis=1)
            res["checks"] = dict(dim=int(qv.shape[1]), dim_ok=qv.shape[1] == m["dim"],
                                 finite=bool(np.isfinite(qv).all() and np.isfinite(dv).all()),
                                 norm_min=float(norms.min()), norm_max=float(norms.max()),
                                 single_vs_batch_min_cos=float((single * qv).sum(1).min()))
np.savez(CACHE / f"{name}.npz", **saved)

# Warm query latency: query embedding + scoring + repo aggregation, after warmup.
zh = [q["zh"] for q in queries]
for q in zh[:5]: encode(model, [q], m["q"])
lat = []
for i in range(60):
    t = time.perf_counter()
    qv = encode(model, [zh[i % len(zh)]], m["q"])
    rank_repos(qv[0], saved["c2_vecs"], list(saved["c2_owner"]))
    lat.append((time.perf_counter() - t) * 1000)
res["warm_query_ms"] = dict(n=60, p50=float(np.percentile(lat, 50)), p95=float(np.percentile(lat, 95)), max=max(lat))
res["peak_rss_bytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # bytes on macOS
json.dump(res, open(f"results/{name}.json", "w"), ensure_ascii=False, indent=1)
print(name, "done", json.dumps(res["checks"]), file=sys.stderr)
