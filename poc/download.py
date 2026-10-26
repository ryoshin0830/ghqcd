import json, sys, time
from pathlib import Path
from huggingface_hub import snapshot_download
from models import MODELS, ALLOW, WEIGHTS, IGNORE
out = {}
for name, m in MODELS.items():
    t = time.perf_counter()
    p = snapshot_download(m["repo"], revision=m["rev"], allow_patterns=ALLOW + WEIGHTS.get(name, ["model.safetensors"]), ignore_patterns=IGNORE)
    size = sum(f.stat().st_size for f in Path(p).rglob("*") if f.is_file())
    out[name] = dict(path=p, seconds=round(time.perf_counter() - t, 1), bytes=size)
    print(name, out[name], file=sys.stderr, flush=True)
json.dump(out, open("results/download.json", "w"), indent=1)
