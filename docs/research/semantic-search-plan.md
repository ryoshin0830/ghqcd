# issue 検索とベクトル検索を ghqcd に入れる計画

## 目標

- **普通の検索（fzf）で issue も探せるようにする。** issue の番号とタイトルが候補に出て、選ぶとそのリポジトリに移動する。
- **ベクトル検索を追加する。** 中国語で用途を書くと、日本語や英語の README・issue からリポジトリが見つかる。
- **他の人が `npx ghqcd` だけで使えるようにする。** Ollama や LM Studio などのアプリ、Python、特定の OS を前提にしない。

## 制約（CLAUDE.md から）

- ghqcd 本体はランタイム依存ゼロ（I9）。npx の起動を遅くしない。
- preinstall / postinstall を足さない。`npm install --ignore-scripts` で動くこと。
- stdout には機械が読む出力だけを書く（I1）。`--json` の既存フィールドは変えない（I7）。
- main への push はリリースになる。作業は PR ブランチで行う。

## 方針（決めたこと）

- **embedding は Node の中で、WASM で動かす。** 依存は `onnxruntime-web`（WASM、install script なし）と `@huggingface/tokenizers`（依存ゼロ）。
  ネイティブの実行基盤は、OS ごとのバイナリ、postinstall、数百 MB の配布物のどれかを伴う（下表）。
- **実行時の依存は ghqcd の依存にしない。** `--index --semantic` の初回に、`lib/runtime/` の package.json と lockfile をキャッシュへ写し、
  `npm ci --ignore-scripts` で入れて、絶対パスで import する。兄弟パッケージを新しく公開せずに済み、全依存のバージョンと integrity が lockfile で固定される。
  （当初は兄弟パッケージを npx で呼ぶ案だったが、公開の手間と、npx が install script を実行する点で、この形に変えた。）
- **issue の取得は GitHub API を fetch で直接叩く。** token は `GH_TOKEN` / `GITHUB_TOKEN`、なければ `gh auth token`。
- **索引は明示的に作る**（`--index`）。キャッシュは `$XDG_CACHE_HOME/ghqcd`、なければ `~/.cache/ghqcd`。

| 実行基盤 | 依存 | install script | 配布物（展開後） |
|---|---|---|---|
| Transformers.js 4.3.1 | sharp, onnxruntime-node, onnxruntime-web(dev) | 依存先にあり | 300MB 超 |
| node-llama-cpp 3.22.2 | 28 個 + OS 別バイナリ | postinstall | 40MB + 19〜33MB |
| onnxruntime-node 1.30.0 | 3 個 | postinstall | 301MB |
| **onnxruntime-web 1.30.0 + @huggingface/tokenizers 0.2.0** | 6 個 + 0 個 | なし | 145MB + 0.4MB |

## 実験結果

### M2. モデルの比較（ST、FP32、MPS）

issue データ: 49 リポジトリ（非公開 23）、issue 348 件。R = description + README、RI = R + issue（max で集約）。R@1。

| モデル | issue 37 問 中国語・英字なし RI | README 19 問 中国語・英字なし RI | README 19 問 中国語・英字なし R |
|---|---|---|---|
| 全文検索 | 16 | 1 | 1 |
| multilingual-e5-small | 13 | 0 | 2 |
| BGE-M3 | 29 | 9 | 11 |
| EmbeddingGemma 2 | 30 | 10 | 14 |
| Granite Embedding 97M multilingual r2 | 25 | 7 | 12 |
| Granite Embedding 311M multilingual r2 | 30 | 11 | 12 |
| Harrier-OSS-v1 270M | 28 | 10 | 13 |
| Harrier-OSS-v1 0.6B | 33 | 13 | 16 |
| **Qwen3-Embedding-0.6B** | **34** | **15** | **17** |

前回の中国語→日本語データ（原文コーパス、中国語・英字なし、19 問）でも、Qwen3 17、Harrier-0.6B 16、Harrier-270M 13、Granite-311M 12、Granite-97M 13 だった。
**公称の MTEB では Harrier が上だが、このデータでは Qwen3-Embedding-0.6B を超えるモデルはなかった。**

### M3. リポジトリ score の集め方（Qwen3、3 言語の合計、R@1）

| 集め方 | issue 111 | README 57 |
|---|---|---|
| max（全 chunk の最大） | 97 | 51 |
| max(R, I − 0.05) | 95 | 53 |
| **max(R, I − 0.1)** | **96** | **55** |

issue の多いリポジトリが、無関係な質問で 1 位を取る問題が減る。δ はこのデータで選んだので、楽観的な値である。
issue を 1 件 1 chunk に絞ると（計算量 1/4）、issue 96 → 93、README は 55 のまま。

### M4. 実行基盤と量子化（Qwen3、Node、M4 Pro、8 スレッド）

| 形式 | 実行基盤 | 速度（トークン/秒） | ST FP32 との cos（40 件、中央値 / 最小） | 配布サイズ |
|---|---|---|---|---|
| FP32 | onnxruntime-node | 1473 | 1.0000 / 1.0000 | 2.4 GB |
| **fp16** | **onnxruntime-web（WASM）** | **360** | **1.0000 / 1.0000** | **1.2 GB** |
| fp16 | onnxruntime-node | 680 | 1.0000 / 1.0000 | 1.2 GB |
| int8（動的量子化） | onnxruntime-node | 1529〜1784 | 0.835 / 0.758 | 614 MB |
| int8 | WASM | 357 | （同上） | 614 MB |
| q4（重みのみ 4bit） | onnxruntime-node / WASM | 1066 / 347 | 0.924〜0.935 / 0.889 | 914 MB |
| q4f16 | どちらも | 動かない | — | 567 MB |

int8 は全件でも測った: issue 97 → 84、README 51 → 45（max）。**量子化で 1 割以上の正解を失う。**
Node 側のトークン化は Python と 260 件で完全一致した（末尾の EOS を含む）。

### M5. 決定

- モデル: Qwen3-Embedding-0.6B、onnx-community の fp16 ONNX（revision `c25a394`、SHA-256 をソースに固定）
- 実行基盤: onnxruntime-web 1.30.0（WASM）+ @huggingface/tokenizers 0.2.0
- 集め方: max(README の最良 chunk, issue の最良 chunk − 0.1)
- issue は全 chunk を入れる（初回は遅いが、再開でき、2 回目以降は差分だけ）

## タスクリスト

### M. モデル調査と実験
- [x] M1 前回の調査以降の候補を探す（Harrier-OSS-v1、Granite Embedding multilingual r2 など）
- [x] M2 品質の参照値: 新候補を ST（FP32）で、前回の中国語→日本語データと issue データの両方で測る
- [x] M3 リポジトリ score の集め方: issue の多いリポジトリが勝ちすぎる問題の対策を比べる
- [x] M4 実行基盤: 上位の候補を Node + onnxruntime-web（WASM）で動かし、ST とのずれ・正解率・速度・サイズを測る
- [x] M5 既定のモデル・量子化・集め方を決める

### P. 実装（PR ブランチ）
- [x] P1 `--index`: README（ローカルのファイル）と description・issue（GitHub GraphQL）をキャッシュに書く（0700 / 0600）
- [x] P2 `--issues`: fzf の候補に issue の行を足す（依存ゼロ、`--exact`）
- [x] P3 `--index --semantic`: 実行時の依存を `npm ci --ignore-scripts` でキャッシュに入れ、モデルを SHA-256 確認つきで取得し、差分だけ embedding する
- [x] P4 `--semantic`: 順位を fzf（並びはそのまま）/ `--json`（`score` つき）で返す
- [x] P5 テスト（GitHub API は偽物、通信なし）、実機での通し確認、README・SKILL.md・CLAUDE.md の更新

## 実機での通し確認（M4 Pro、公開リポジトリ 11 件の一時 ghq root）

- `--index`: 11 リポジトリ、issue 22 件、2 秒。
- `--index --semantic` の初回: 実行時の依存の導入、モデル 1.2GB のダウンロードとハッシュ確認、110 chunk の embedding まで 170 秒。2 回目は embedding 0 件で 3 秒。
- `--semantic` 1 回: 約 1.8 秒（Node の起動、WASM の読込、1.2GB のモデルの読込を含む）。
- 中国語の質問 6 問で、1 位が正解だったのは 4 問。
  - portfolio は README が Next.js のテンプレートのままで、description も空。0.002 差の 2 位だった。
  - 「リポジトリを選んで移動する」は、gwqpull の README の Related 欄に ghqcd の説明文がそのまま書かれていて、gwqpull が 1 位、ghqcd は 4 位。
    兄弟ツールが互いの説明を README に載せていると、取り違えが起きる。
- `--issues`: fzf のあいまい一致では、存在しない語（`zzzznotfound`）でも長い issue 本文に当たってしまった。`--exact` に変えて直した。
