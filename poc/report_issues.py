# D: stdout = aggregate tables safe for the public doc (no repo names, no text).
# Failures with names and query text go to the cache only.
import json, os
from common import ISSUES, load_queries

corpus = {d["id"]: d for d in json.load(open(ISSUES / "corpus.json"))}
Q = {q["id"]: q for q in load_queries() + json.load(open(ISSUES / "queries_issue.json"))}
runs = json.load(open(ISSUES / "results.json"))["runs"]
GROUPS = {"issue": {"issue"}, "README": {"use", "sibling"}}
THIN = lambda r: len(corpus[r]["readme"]) < 200


def ranks(key, kinds, pred=lambda q: True):
    return [next(i for i, (r, _) in enumerate(x["ranking"], 1) if r == Q[x["id"]]["answer"])
            for x in runs[key] if Q[x["id"]]["kind"] in kinds and pred(Q[x["id"]])]


def cell(rs):
    return f"{sum(r == 1 for r in rs)}/{len(rs)} ({sum(r <= 5 for r in rs)})"


for g, kinds in GROUPS.items():
    print(f"\n### {g} 質問（R@1、カッコ内は Top5）\n")
    print("| 方式 | 索引 | 日本語 | 中国語 | 中国語・英字なし |\n|---|---|---|---|---|")
    for m in ["lexical", "qwen3"]:
        for ix in ["R", "RI"]:
            print(f"| {m} | {ix} | " + " | ".join(cell(ranks(f"{m}/{ix}/{l}", kinds)) for l in ["ja", "zh", "zh_nolatin"]) + " |")

print("\n### issue 質問を README の厚さで分けたもの（qwen3、中国語・英字なし、R@1）\n")
print("| 正解リポジトリの README | R | RI |\n|---|---|---|")
for label, pred in [("200 文字未満", lambda q: THIN(q["answer"])), ("200 文字以上", lambda q: not THIN(q["answer"]))]:
    print(f"| {label} | " + " | ".join(cell(ranks(f"qwen3/{ix}/zh_nolatin", {"issue"}, pred)) for ix in ["R", "RI"]) + " |")

print("\n### README 質問への影響（qwen3、R → RI、1 位の正誤が変わった数）\n")
print("| 言語 | 正→誤 | 誤→正 | RI で誤った 1 位のうち issue 10 件以上のリポジトリ |\n|---|---|---|---|")
local = []
for l in ["ja", "zh", "zh_nolatin"]:
    a = {x["id"]: x["ranking"][0][0] for x in runs[f"qwen3/R/{l}"]}
    b = {x["id"]: x["ranking"][0][0] for x in runs[f"qwen3/RI/{l}"]}
    ids = [i for i in a if Q[i]["kind"] in GROUPS["README"]]
    lost = [i for i in ids if a[i] == Q[i]["answer"] != b[i]]
    won = [i for i in ids if a[i] != Q[i]["answer"] == b[i]]
    wrong = [b[i] for i in ids if b[i] != Q[i]["answer"]]
    print(f"| {l} | {len(lost)} | {len(won)} | {sum(len(corpus[r]['issues']) >= 10 for r in wrong)}/{len(wrong)} |")

print("\n### 正解なし質問（qwen3、中国語）\n")
print("| 索引 | 正解した 1 位 score の最小 | 正解なし 1 位 score の最大 | 全正解を通す閾値で残る正解なし |\n|---|---|---|---|")
for ix in ["R", "RI"]:
    xs = runs[f"qwen3/{ix}/zh"]
    pos = [x["ranking"][0][1] for x in xs if Q[x["id"]]["answer"] and x["ranking"][0][0] == Q[x["id"]]["answer"]]
    neg = [x["ranking"][0][1] for x in xs if not Q[x["id"]]["answer"]]
    print(f"| {ix} | {min(pos):.3f} | {max(neg):.3f} | {sum(n >= min(pos) for n in neg)}/{len(neg)} |")

for key, xs in runs.items():
    for x in xs:
        q = Q[x["id"]]
        if q["answer"] and x["ranking"][0][0] != q["answer"]:
            r = next(i for i, (n, _) in enumerate(x["ranking"], 1) if n == q["answer"])
            local.append(f"| {key} | {q['kind']} | {q[key.rsplit('/', 1)[1]]} | {q['answer']} | {x['ranking'][0][0]} | {r} |")
p = ISSUES / "failures.md"
p.write_text("| run | kind | 質問 | 正解 | 1位 | 正解の順位 |\n|---|---|---|---|---|---|\n" + "\n".join(local) + "\n")
os.chmod(p, 0o600)
