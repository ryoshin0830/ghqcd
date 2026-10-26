import json, sys, time
from pathlib import Path
from huggingface_hub import snapshot_download
from models import MODELS, ALLOW, WEIGHTS, IGNORE
R = Path("results/download.json")
out = json.loads(R.read_text()) if R.exists() else {}
for name in sys.argv[1:] or MODELS:
    m = MODELS[name]
    t = time.perf_counter()
    p = snapshot_download(m["repo"], revision=m["rev"], allow_patterns=ALLOW + WEIGHTS.get(name, ["model.safetensors"]), ignore_patterns=IGNORE)
    size = sum(f.stat().st_size for f in Path(p).rglob("*") if f.is_file())
    out[name] = dict(seconds=round(time.perf_counter() - t, 1), bytes=size)
    print(name, out[name], file=sys.stderr, flush=True)
json.dump(out, open(R, "w"), indent=1)
