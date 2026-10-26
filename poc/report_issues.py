# D: stdout = aggregate tables safe for the public doc (no repo names, no text).
# usage: python report_issues.py [model ...]   (default: every ISSUES/results/*.json)
# Failures with names and query text go to the cache only.
import json, os, sys
from common import ISSUES, load_queries

corpus = {d["id"]: d for d in json.load(open(ISSUES / "corpus.json"))}
Q = {q["id"]: q for q in load_queries() + json.load(open(ISSUES / "queries_issue.json"))}
names = sys.argv[1:] or sorted(p.stem for p in (ISSUES / "results").glob("*.json"))
RES = {n: json.load(open(ISSUES / "results" / f"{n}.json")) for n in names}
GROUPS = {"issue": {"issue"}, "README": {"use", "sibling"}}
LANGS = ["ja", "zh", "zh_nolatin"]
THIN = lambda r: len(corpus[r]["readme"]) < 200
AGG = {"max": lambda r, i: max(r, i), "max(R,I-0.05)": lambda r, i: max(r, i - 0.05), "max(R,I-0.1)": lambda r, i: max(r, i - 0.1)}


def rank(ranking, answer):
    return next(k for k, (r, _) in enumerate(ranking, 1) if r == answer)


def runs_with(res, lang, agg):
    """Rankings for RI under an aggregation rule, from the per-repo split scores."""
    if agg == "max" or not res["split"]: return res["runs"][f"RI/{lang}"]
    f = AGG[agg]
    return [dict(id=x["id"], ranking=sorted(((r, f(a, -9.0 if b is None else b)) for r, (a, b) in x["scores"].items()),
                                         key=lambda kv: (-kv[1], kv[0]))) for x in res["split"][lang]]


def r1(runs, kinds, pred=lambda q: True):
    rs = [rank(x["ranking"], Q[x["id"]]["answer"]) for x in runs if Q[x["id"]]["kind"] in kinds and pred(Q[x["id"]])]
    return sum(r == 1 for r in rs), sum(r <= 5 for r in rs), len(rs)


cell = lambda t: f"{t[0]}/{t[2]} ({t[1]})"

for g, kinds in GROUPS.items():
    print(f"\n### {g} 質問（R@1、カッコ内は Top5。索引 R → RI、RI は max で集約）\n")
    print("| 方式 | " + " | ".join(f"{l} R | {l} RI" for l in LANGS) + " |\n|---|" + "---|" * 6)
    for n, res in RES.items():
        print(f"| {n} | " + " | ".join(f'{cell(r1(res["runs"][f"R/{l}"], kinds))} | {cell(r1(res["runs"][f"RI/{l}"], kinds))}' for l in LANGS) + " |")

print("\n### README が 200 文字未満のリポジトリへの issue 質問（中国語・英字なし、R@1、R → RI）\n")
print("| 方式 | R | RI |\n|---|---|---|")
for n, res in RES.items():
    print(f"| {n} | " + " | ".join(cell(r1(res["runs"][f"{ix}/zh_nolatin"], {"issue"}, lambda q: THIN(q["answer"]))) for ix in ["R", "RI"]) + " |")

print("\n### 集め方の比較（RI、R@1。issue 37 問 / README 19 問の合計を 3 言語で）\n")
print("| 方式 | " + " | ".join(f"{a} issue | {a} README" for a in AGG) + " |\n|---|" + "---|" * (2 * len(AGG)))
for n, res in RES.items():
    if not res["split"]: continue
    row = []
    for a in AGG:
        for kinds in GROUPS.values():
            t = [r1(runs_with(res, l, a), kinds) for l in LANGS]
            row.append(f"{sum(x[0] for x in t)}/{sum(x[2] for x in t)}")
    print(f"| {n} | " + " | ".join(row) + " |")

print("\n### 正解なし質問（中国語、RI・max）\n")
print("| 方式 | 正解した 1 位 score の最小 | 正解なし 1 位 score の最大 | 全正解を通す閾値で残る正解なし |\n|---|---|---|---|")
for n, res in RES.items():
    if n == "lexical": continue
    xs = res["runs"]["RI/zh"]
    pos = [x["ranking"][0][1] for x in xs if Q[x["id"]]["answer"] and x["ranking"][0][0] == Q[x["id"]]["answer"]]
    neg = [x["ranking"][0][1] for x in xs if not Q[x["id"]]["answer"]]
    print(f"| {n} | {min(pos):.3f} | {max(neg):.3f} | {sum(v >= min(pos) for v in neg)}/{len(neg)} |")

local = []
for n, res in RES.items():
    for key, xs in res["runs"].items():
        for x in xs:
            q = Q[x["id"]]
            if q["answer"] and x["ranking"][0][0] != q["answer"]:
                local.append(f"| {n}/{key} | {q['kind']} | {q[key.split('/')[1]]} | {q['answer']} | {x['ranking'][0][0]} | {rank(x['ranking'], q['answer'])} |")
p = ISSUES / "failures.md"
p.write_text("| run | kind | 質問 | 正解 | 1位 | 正解の順位 |\n|---|---|---|---|---|---|\n" + "\n".join(local) + "\n")
os.chmod(p, 0o600)
