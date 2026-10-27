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
- issue は 1 件 1 chunk（タイトルと本文の先頭）。当初は全 chunk だったが、実データで 3.5 時間かかったので変えた（下の「実データでの確認」）

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

## 実データでの確認（ローカルと Docker）

### ローカル（M4 Pro、Node 24、ghq のリポジトリ 55 件）

- `--index`: 6 秒。README 54 件、GitHub 上のリポジトリ 46 件、issue 1,571 件。
- issue を全 chunk 入れると 12,765 chunk になり、初回の見込みは約 3.5 時間だった（issue 1 件あたり平均 8 chunk）。
  1 件 1 chunk に変えて 1,796 chunk、37 分（途中は Docker と CPU を取り合った）。
- `--semantic` 1 回: 中央値 2.1 秒（スレッド 8）、2.7 秒（スレッド 1）。30 回連続で止まらない。
- 中国語の質問 7 問で 1 位が正解は 5 問。外れのうち 1 問は、前回と同じ gwqpull の Related 欄による取り違え。

### Docker（Linux arm64、Debian bookworm、fzf 0.38、公開リポジトリ 18 件を SSH で clone）

- npm pack した tarball を `npm install -g --ignore-scripts` で入れて動かした。
- Node 22 と Node 20 のどちらでも、まっさらなキャッシュから `--index --semantic` が通った（ランタイムの導入、モデルのダウンロードとハッシュ確認、embedding）。
  Node 20 の初回は 116 chunk で 8 分 16 秒。
- Node 20（half の復号経路）と Node 22 のベクトルは 116 chunk すべてで cos 1.000000。
- 中国語の質問 13 問で 1 位が正解は 11 問（Node 20 と Node 22 で同じ順位と score）。
- トークン: `GH_TOKEN`、`gh auth login`、トークンなしのどれでも動いた。他人のリポジトリ（x-motemen/ghq）の issue は取り込まない。
- 対話 UI（tmux から操作）: bash と zsh の関数経由で、`--semantic` と `--issues` の一覧、Enter での移動、Esc（exit 130、エラー表示なし）。

### この確認で直したこと

- トークンが無効（401）のとき、またはトークンがないときに、`--index` が前回の issue を消していた。前回の内容を残すようにした。
- NOT_FOUND（消えた・アクセスできないリポジトリ）と gist を「API エラー」と数えていた。skip として数え、本物のエラーには最初の 1 件の内容を出すようにした。
- `--issues` の対話 UI で、本文の奥で一致した行が横にスクロールし、リポジトリ名と issue 番号が見えなかった。`--no-hscroll` を足した。
- 埋め込み中は SIGTERM / SIGHUP が効かなかった（ORT の `run()` がイベントループに戻らないため）。1 chunk ごとに戻るようにした。
- Node 20 で `--semantic` がまれにセッション作成の中で止まり、SIGTERM も効かなかった（15 回に 1 回）。検索はスレッド 1 本にした（45 回で 0 回）。
- テストが開発者の `gh auth token` を拾って GitHub に通信しうる状態だった。失敗する `gh` の shim を置いた。

## 更新のしかた

- 索引は `--index` を実行したときだけ更新する。自動では更新しない（非公開の issue を読むため）。
  `--issues` と `--semantic` は、索引が 7 日より古いと stderr に 1 行知らせる。
- 差分は 2 段で検知する。
  1. README と issue の原文ごとの SHA-256。前回と同じで、ベクトルがそろっていれば、前回の chunk 一覧を使う（トークン化しない）。
  2. chunk の文章ごとの SHA-256。前回のベクトルにないものだけ embedding する。
- モデルは、原文が 1 件でも変わったときだけ読み込む。
- `--index` は同時に 1 本だけ（`index.lock`）。2 本が同じベクトルのファイルに追記して壊れたことがあった。

| 場合（ローカル、55 リポジトリ、1,796 chunk） | 修正前 | 修正後 |
|---|---|---|
| 変更なし | 31〜33 秒（全文のトークン化 20 秒、モデルの読み込み 3 秒を含む） | 8〜9 秒（GitHub からの取得だけ） |
| README 1 件が変わった | 31 秒前後 | 12 秒（0 chunk の embedding） |
| ベクトルが 1 件欠けていた | — | 11 秒（1 chunk の embedding） |

Docker（Node 20、7 リポジトリ）: 初回 140 秒、変更なしの 2 回目 1 秒。

### 未確認

- Windows、x86_64、macOS 以外での fzf の新しい版。
- Node 20 の索引作成（スレッド 8 本）で同じ停止が起きるか。2 回の初回作成では起きていない。起きたら Ctrl-C で止めて再実行すれば続きから進む。

## 1 つの検索ウィンドウへ（2026-10-27）

利用者の要件で、`--issues` と `--semantic` の別画面をやめ、`ghqcd` の 1 つのウィンドウにまとめた。
設計は `docs/superpowers/specs/2026-10-27-unified-search-design.md`、計画は `docs/superpowers/plans/2026-10-27-unified-search.md`。

- 対象: clone 済み、GitHub / GHE で自分のリポジトリ（README・issue・ベクトルまで）、組織が共有するリポジトリ（名前と description だけ）。
  手元の実データでは、github.com 174 件、GHE の自分のもの 27 件、組織のもの 2,044 件。
- 順位: 名前 > description > README > issue（キーワード、`lib/rank.mjs`）、その下に意味（cos ≥ 0.45）、最後にコード。
- 意味検索は既定でオン。索引は、ウィンドウを開いたときに古ければ裏で更新し、下部のステータスバーに進捗を出す。
- 実測（M4 Pro、tmux から操作）:
  - `lj` で clone していない `ryoshin0830/lj` が先頭。
  - Enter で `ghq get` してから移動した。
  - 中国語の質問は、意味の行が約 5 秒で足される（初回のモデル読み込みを含む）。
  - 関数名の質問は、`git grep` の結果が約 6 秒、GitHub のコード検索の結果も約 6 秒で出た。
  - 自分のリポジトリを足した初回の索引更新では、513 chunk を約 8 分で embedding した。
