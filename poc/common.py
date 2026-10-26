import hashlib, json
from pathlib import Path
import numpy as np

CACHE = Path.home() / "Library/Caches/ghqcd-poc/zhja"
ISSUES = CACHE.parent / "issues"  # private data: never commit anything from here
CORPORA = ["c1", "c2"]  # c1: original README + description (mixed languages); c2: Japanese-only
LANGS = ["ja", "zh", "en", "zh_nolatin"]
FROZEN = ["data/c1_original.json", "data/c2_ja.json", "data/queries.json"]


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def verify_manifest():
    man = json.load(open("data/manifest.json"))
    for p in FROZEN:
        assert man[p] == sha(p), f"{p} changed after freezing"


def load_corpora():
    c1 = [dict(id=d["id"], text="\n\n".join(x for x in [d["id"], d["description"], d["readme"]] if x))
          for d in json.load(open("data/c1_original.json"))]
    c2 = [dict(id=d["id"], text=f'{d["id"]}\n\n{d["text"]}') for d in json.load(open("data/c2_ja.json"))]
    return {"c1": c1, "c2": c2}


def load_queries():
    return json.load(open("data/queries.json"))


def rank_repos(qv, doc_vecs, owner):
    """Repo score = best chunk cosine. Ties broken by repo id. Returns [(repo, score), ...]."""
    s = doc_vecs @ qv
    best = {}
    for o, x in zip(owner, s):
        best[o] = max(best.get(o, -9.0), float(x))
    return sorted(best.items(), key=lambda kv: (-kv[1], kv[0]))
