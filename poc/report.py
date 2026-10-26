# Aggregate results/*.json into markdown tables (stdout) and results/summary.json.
import json, sys
import numpy as np
from common import load_queries

METHODS = ["lexical", "e5-small", "qwen3-0.6b", "gemma2", "bge-m3", "harrier-0.6b", "harrier-270m", "granite-311m", "granite-97m"]
Q = {q["id"]: q for q in load_queries()}
R = {m: json.load(open(f"results/{m}.json")) for m in METHODS}


def rank_of(run, answer):
    return next(i for i, (r, _) in enumerate(run["ranking"], 1) if r == answer)


def metrics(runs, kinds):
    rs = [rank_of(x, Q[x["id"]]["answer"]) for x in runs if Q[x["id"]]["kind"] in kinds]
    return dict(n=len(rs), r1=sum(r == 1 for r in rs) / len(rs), r5=sum(r <= 5 for r in rs) / len(rs),
                mrr=float(np.mean([1 / r for r in rs])))


def auroc(pos, neg):
    return float(np.mean([(p > n) + 0.5 * (p == n) for p in pos for n in neg]))


POS = {"use", "sibling"}  # usage-described intents; the name-only query (q02) is reported apart
summary = {}
for c, cl in [("c2", "日本語のみコーパス"), ("c1", "原文コーパス")]:
    print(f"\n### {cl}（用途の質問19問、カッコ内はTop5）\n")
    print("| 方式 | 日本語 R@1 | 中国語 R@1 | 中国語・英字なし R@1 | 英語 R@1 | 中国語 MRR |")
    print("|---|---|---|---|---|---|")
    for m in METHODS:
        row = {l: metrics(R[m]["runs"][f"{c}/{l}"], POS) for l in ["ja", "zh", "zh_nolatin", "en"]}
        summary[f"{c}/{m}"] = row
        f = lambda x: f'{round(x["r1"]*x["n"])}/{x["n"]} ({round(x["r5"]*x["n"])})'
        print(f'| {m} | {f(row["ja"])} | {f(row["zh"])} | {f(row["zh_nolatin"])} | {f(row["en"])} | {row["zh"]["mrr"]:.2f} |')

print("\n### 似たツールの区別（gwq系・ghq系の5問、日本語のみコーパス、R@1）\n")
print("| 方式 | 日本語 | 中国語 | 中国語・英字なし |\n|---|---|---|---|")
for m in METHODS:
    f = lambda l: (lambda x: f'{round(x["r1"]*x["n"])}/{x["n"]}')(metrics(R[m]["runs"][f"c2/{l}"], {"sibling"}))
    print(f'| {m} | {f("ja")} | {f("zh")} | {f("zh_nolatin")} |')

print("\n### 正解なし質問の識別（日本語のみコーパス、中国語）\n")
print("| 方式 | 正解あり1位score 中央値 | 正解なし1位score 最大 | AUROC | 全正解を通す閾値で残る正解なし |")
print("|---|---|---|---|---|")
for m in METHODS[1:]:
    runs = R[m]["runs"]["c2/zh"]
    pos = [x["ranking"][0][1] for x in runs if Q[x["id"]]["kind"] in POS and x["ranking"][0][0] == Q[x["id"]]["answer"]]
    neg = [x["ranking"][0][1] for x in runs if Q[x["id"]]["kind"].startswith("negative")]
    summary[f"neg/{m}"] = dict(pos=pos, neg=neg, auroc=auroc(pos, neg))
    print(f"| {m} | {np.median(pos):.3f} | {max(neg):.3f} | {auroc(pos, neg):.2f} | {sum(n >= min(pos) for n in neg)}/{len(neg)} |")

print("\n### 中国語→日本語のみコーパスで1位を外した質問\n")
print("| 方式 | 質問 | 正解 | 1位 | 正解の順位 |\n|---|---|---|---|---|")
for m in METHODS:
    for l in ["zh", "zh_nolatin"]:
        for x in R[m]["runs"][f"c2/{l}"]:
            q = Q[x["id"]]
            if q["kind"] in POS | {"name"} and x["ranking"][0][0] != q["answer"]:
                print(f'| {m} | {q[l]} | {q["answer"]} | {x["ranking"][0][0]} | {rank_of(x, q["answer"])} |')

print("\n### 性能（MPS / FP32 / batch 4）\n")
print("| モデル | 取得容量 | 読込 | 索引 日本語のみ (chunk) | 索引 原文 (chunk) | 検索 P50 / P95 | ピークRSS | 単独とbatchの最小cos | 次元・有限・単位norm |")
print("|---|---|---|---|---|---|---|---|---|")
for m in METHODS[1:]:
    r = R[m]; ch = r["checks"]; w = r["warm_query_ms"]
    ok = ch["dim_ok"] and ch["finite"] and abs(ch["norm_min"] - 1) < 1e-4 and abs(ch["norm_max"] - 1) < 1e-4
    print(f'| {m} | {r["download"]["bytes"]/2**30:.2f} GiB | {r["load_s"]:.1f} s | {r["index"]["c2"]["seconds"]:.1f} s ({r["index"]["c2"]["chunks"]}) | '
          f'{r["index"]["c1"]["seconds"]:.1f} s ({r["index"]["c1"]["chunks"]}) | {w["p50"]:.0f} / {w["p95"]:.0f} ms | '
          f'{r["peak_rss_bytes"]/2**30:.2f} GiB | {ch["single_vs_batch_min_cos"]:.5f} | {"OK" if ok else "NG"} |')
json.dump(summary, open("results/summary.json", "w"), indent=1)
