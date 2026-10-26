# B2: no issue query may copy a 4+ character run from its answer repo's text; zh_nolatin has no Latin letters.
# Prints offending query ids only (the text is private). Exit 1 if any.
import json, re, sys, unicodedata
from common import ISSUES as OUT

norm = lambda s: re.sub(r"\s+", "", unicodedata.normalize("NFKC", s).casefold())
repos = {d["id"]: d for d in json.load(open(OUT / "corpus.json"))}
bad = []
for q in json.load(open(OUT / "queries_issue.json")):
    d = repos[q["answer"]]
    src = norm("\n".join([d["id"], d["description"], d["readme"]] + [i["title"] + i["body"] for i in d["issues"]]))
    for lang in ["ja", "zh", "zh_nolatin"]:
        t = norm(q[lang])
        hit = next((t[i:i + 4] for i in range(len(t) - 3) if t[i:i + 4] in src), None)
        if hit: bad.append((q["id"], lang, "copy"))
    if re.search(r"[A-Za-z]", q["zh_nolatin"]): bad.append((q["id"], "zh_nolatin", "latin"))
print(json.dumps(bad))
sys.exit(1 if bad else 0)
