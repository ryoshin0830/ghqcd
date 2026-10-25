# 多言語リポジトリ検索PoC 設計

状態: 初回の独立レビュー7指摘を反映した第2版。再審査とユーザーレビューを待つ。

## 目的

名前を忘れた自作リポジトリを用途から発見できるかを、再現可能なローカル実験で判断する。特に、日本語で書かれた説明を、中国語の質問から翻訳なしで検索できるかを測る。通常のghqcdへ組み込むかどうかは、実測後の判断とする。

PoCの完成条件は、モデルの固定、コーパスと正解集合の固定、索引の作成・差分更新・検索・削除、言語別評価、性能測定、安全性検証、20原則の証拠、独立レビュー、PRの作成と表示が揃うこと。どのモデルの精度も予め保証しない。

## 比較した案

| 案 | 利点 | 費用・問題 | 判断 |
| --- | --- | --- | --- |
| 独立PoCでローカル索引と評価を作る | 本体を保ち、失敗例・最新モデル・安全性を検証できる | Python等の検証環境が別途必要 | 今回採用する案 |
| ghqcd本体へ直ちに意味検索を追加する | 日常操作へ直接接続できる | 未確定のモデル・起動時間・依存を製品契約へ持ち込む | 実測後に判断 |
| モデル単体のベンチマークだけを行う | 実装が小さい | 保存・更新・削除・検索の実際の課題を検証できない | 先行実験に留める |

## 制約

- `bin/ghqcd.mjs`、既存JSON schema、シェル初期化、Node >=20.12、実行時npm依存なしを維持する。
- PoCを`poc/`に置き、Python依存はPoC専用環境へ固定する。npm配布物へPoC・重み・コーパス・索引を含めない。
- モデル・tokenizer・poolingの実装はリリース済みの既知ライブラリを使う。`trust_remote_code=False`、Safetensors、モデルcommit SHA固定を必須にする。
- モデル取得と公開GitHub取得は明示したコマンドだけが通信する。索引・検索・評価は取得後にオフラインで動く。
- 実験は公開コーパスのみ。private repoを収集しない。外部embedding/生成APIを使用しない。
- `main`へpush・mergeせず、PoCブランチのPRを作る。作業用worktreeを保持する。

## モデル選定

2026-10-26の一次資料調査を別記する。実測するモデルは次の4つを基本とし、実装・利用条件に問題が出た場合は、除外理由を記録して採用を見直す。

| Profile | 固定モデル | 役割 | 前処理 |
| --- | --- | --- | --- |
| e5-small | intfloat/multilingual-e5-small | 小型の従来比較基準 | query: / passage:、masked mean、L2正規化 |
| qwen3-small | Qwen/Qwen3-Embedding-0.6B | 現行の多言語候補 | 公式query instruction、文書はそのまま、last nonpadding、L2正規化 |
| gemma2 | google/embeddinggemma-2 | 2026-10公開の新しい小型候補 | 公式SearchQuery / Document prompt、公式pooling・projection、text-only |
| bge-m3 | BAAI/bge-m3 | 広く利用される多言語比較基準 | prefixなし、dense CLS、L2正規化 |

モデルを直接一律のmean/CLSで処理しない。Sentence Transformersの公式構成を使い、query/documentのpromptをprofileで明示する。Gemma2はvision/audioを無効化する。基本比較は同じCPU/MPSデバイス、FP32、batch size 4、最大入力512 tokensとし、対応しない組合せは勝手に混在させず報告する。既存のMLX 4-bit結果は参考値として別表に置く。
+
+Python 3.12、Sentence Transformers 6.2.0、Transformers 5.20.2、PyTorch 2.14.1をPoC lockへ固定する。4モデルのrevisionは以下を使用する。
+
+```text
+e5-small 614241f622f53c4eeff9890bdc4f31cfecc418b3
+qwen3-small 97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3
+gemma2 914f7f89142e33e77833254d9c9b90c3cef7303b
+bge-m3 5617a9f61b028005a4858fdac845db406aefb181
+```
+
+profile manifestはモデルとtokenizerのrevision、loader version、許可module class、query/document template、pooling/projection、L2正規化、出力次元、padding side、special token込みの上限、dtype/device、adapter versionを持つ。
+
+- E5: `query: {query}` / `passage: {document}`、384次元、right padding。
+- Qwen: `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:{query}` / `{document}`、1024次元、left padding、last nonpadding token。
+- Gemma2: `task: search result | query: {query}` / `title: none | text: {document}`、768次元、公式text-only構成。loaderへ`config_kwargs={"vision_config": None, "audio_config": None}`を指定する。title prefixを重ねない。モデル内projectionと公式mean poolingを保持する。
+- BGE-M3: `{query}` / `{document}`、1024次元、right padding、dense CLSのみ。
+
+許可するST moduleはTransformer/Pooling/Normalizeの旧公開パス`sentence_transformers.models.*`と、Gemma2が指定する`sentence_transformers.base.modules.transformer.Transformer`、`sentence_transformers.sentence_transformer.modules.pooling.Pooling`、`sentence_transformers.base.modules.normalize.Normalize`だけとする。相対module pathの逸脱と未知moduleを拒否する。既知実装を使うGemma2のprojectionはST外部moduleとして再実装しない。
+
+モデル取得後はローカルsnapshot path、`local_files_only=True`、`trust_remote_code=False`、`use_safetensors=True`でloadする。pickle fallbackとモデルrepoのPythonを禁止する。実データ評価前にprefixとtoken数を確認し、同じ入力の単独/batch出力が許容誤差内で一致すること、次元・有限性・単位norm、公式ST経路との一致を検証する。公式根拠は[モデル調査](../../research/model-survey-2026-10.md)に記載する。

Jina v5、Nomic v2、Perplexity等も調査する。remote code、非商用条件、multi-vector方式、追加runtimeなどの差を明示し、流行や総合順位だけで選ばない。

## データと評価

### コーパス

1. 公開リポジトリのREADME・descriptionの固定snapshot。出典URL・repo名・ref・blob SHA・取得日時を保持する。元データは先行調査の26 repo / 24 READMEを引き継ぎ、取得日を明記する。
2. 日本語限定の監査可能な評価用コーパス。公開READMEの日本語の抜粋、または出典に基づく日本語の用途説明を用い、どちらかを各文書に明示する。中国語訳や検索クエリ・正解ラベルは本文に入れない。作成した説明を原文READMEと誤称しない。

文書は`id`, `repo`, `language`, `title`, `text`, `source_url`, `revision`, `collected_at`, `source_kind`, `visibility`を持つ。source_kindは原文README・原文description・出典付き日本語説明を区別する。revisionは出典のcommit/blob SHAまたはdescription snapshotのSHA-256であり、derived説明は元の出典revisionも保持する。固定fixtureに非公開情報、トークン、秘密鍵を含めない。
+
+PoCのindex/evaluate対象は、チェックインしたfixture manifestのdataset IDとSHA-256に一致する2集合に限定する。任意のローカルJSONを「public」と自己申告して受け入れる機能は作らない。collectは匿名の公開GitHub APIでownerの公開repo一覧を取得し、`private=false`を確認してからREADMEを取得する。外部URLやローカルrepo走査は受け付けない。新規収集snapshotを評価へ追加するにはprovenanceを確認し、fixture manifestとqrelsを明示更新する。

### クエリ

同じ検索意図に日本語・中国語・英語のクエリを対応させる。最低20意図×3言語を用意し、用途の言い換え、名前・別名、似たツールの区別、コード/API名、未収録の話題を分ける。日中の評価は翻訳を挟まず、正解のrepo ID集合を索引外のqrelsに持つ。

日本語限定コーパスは言語宣言と日本語の文を人手で確認する。漢字が共通することから「中国語文字がゼロ」という判定を機械的に主張しない。英字の製品名・コード識別子は残し、その存在を明記する。

全方式の採点前に、問い合わせの3言語版・qrels・コーパス・派生説明・alias・全文パラメータ・repo集約・RRFを固定し、SHA-256を記録する。先行の20問を見て設計した探索的データであることを明示する。全queryについて、小さいコーパス全repoを正解候補として検討し、qrelsのID存在と翻訳間の意図・正解集合の一致を検証する。評価を見て調整した方式は探索的な結果と明記する。自作の小規模評価を一般的なベンチマーク精度と表現しない。
+
+正例のRecall@kは`|上位kのrepo ID ∩ 正解repo ID| / |正解repo ID|`、MRRは最初の正解repoの順位の逆数。言語/corpus/group内でqueryごとのmacro平均を取る。正解なしのqueryは別表で件数、非空結果率、返されたscore/近傍を記録する。未校正の閾値で後付けの棄却性能を主張しない。

### 検索方式

- 固有名・別名の完全一致。
- ローカル全文検索。日本語向けの単純なtrigram等を用いた方式であることを明記する。
- 正規化した単一ベクトルのcosine検索。文書chunkをrepo単位に集約する。
- 比較用の単純RRF。常に意味検索より良いとは扱わない。

採点前にrankingを固定する。embedding対象の本文にrepo/titleを一度だけ含め、正解aliasを後付けしない。lexicalはNFKCとcasefold、ASCII tokenと日本語文字trigramのOR、TF-IDF相当の固定重みで採点する。意味scoreはrepo内chunk scoreの最大値。RRFは各方式のrepo上位10件、k=60、等重み。tieはrepo IDの辞書順とする。max集約が長文repoに有利になり得る点とchunk数を報告する。
+
+各modelのtokenizerで上限内に段落/長段落を分割するため、これはtokenizerを含むend-to-end pipeline比較と呼ぶ。共通の原文、query、正解、最大token予算を保ち、各modelのchunk数と本文露出量・処理token数を必ず記録する。モデル単体の公平なFLOPs比較とは称さない。
+
+初期の索引はexact scanで十分な規模とし、専用vector DB/ANNサーバは追加しない。自然言語用途検索では意味検索を重視し、完全一致を別途表示できる。未収録の話題でも近傍は返り得るため、確度が未校正のscoreを正解の確率と表示しない。

## 保存と更新

索引は作業repo外の指定cache directoryに置く。推奨初期値はmacOSの`~/Library/Caches/ghqcd-poc`、Linuxは`XDG_CACHE_HOME/ghqcd-poc`または`~/.cache/ghqcd-poc`。private corpusは受け付けないPoCとするが、保存境界は将来の非公開利用も想定する。

cacheの名前空間はhost/account、dataset ID、model profileとrevision、前処理versionを含む。namespaceのcomponentは固定値または`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`で検証する。入力JSON、model ID、dimension、chunk設定を検証する。管理rootと子directoryは0700、ファイルは0600。tokenは保存しない。
+
+管理root/子directoryとlock/snapshotのsymlinkを拒否する。privateな管理directoryをO_DIRECTORY/O_NOFOLLOWで開き、同じdirfdに対して相対open/replace/unlinkを行う。`resolve()`後に通常のpath書込みをするだけの実装にはしない。脅威境界は単一OSユーザーのローカル操作であり、同一権限の悪意あるアプリからの完全隔離は保証しない。

embeddingの再利用キーはモデル/tokenizer revision、prompt、pooling/projection/normalization、dimension、dtype/backend policy、adapter implementation version、chunk設定、固定依存versionを含む全profile fingerprintと、実際にformat済みの入力文章のhash。安定した段落を優先して分割し、上限を超える段落のみtoken単位で重複付き分割する。prefixとspecial tokenを含めて上限以内にし、黙ってtruncateしない。

メタデータ、doc/chunk対応、vectorを1つのJSON snapshotに保存する。サイズ制限内で完成させたsnapshotを同じfilesystemの0600一時ファイルへ書き、flush/fsync後にatomic replaceする。readerは1つの完成ファイルを開いて読む。process中断について旧版または新版の完成状態を保証し、電源断に対する完全な耐久性までは保証しない。
+
+indexとpurgeは同じfcntl flockを使う。lockはkernelによりprocess終了時に解放される。purgeはlockファイルを残し、管理snapshotと一時ファイルのみを同じdirfdから削除する。lock inodeを消して競合する新lockを作らない。途中失敗・並行writer・purge競合・破損snapshotをテストする。消えた文書のchunkは次のsnapshotへ持ち越さない。モデル・次元・prompt・分割設定が変われば古いvectorを混ぜない。

索引は再構築可能なデータ。`purge`は指定namespace内のPoC管理ファイルだけを削除する。通常の削除ではAPFS snapshotやバックアップからの完全消去を保証しない。SQLiteを採用する場合はFTS shadow table/WALへの残存も調査し、実装の実態を説明する。

### ベクトルを作るタイミング

| イベント | 処理 |
| --- | --- |
| 初回の明示index | 取得済みの対象文書を作成 |
| 同じ条件・同じ文書で再index | 既存vectorを再利用、embedding呼出し0 |
| 一部文書の変更 | 新しい文章だけを再処理 |
| 文書削除 | 対応する古いchunkを除外 |
| モデル・前処理変更 | 別namespaceに全対象を再計算 |
| 入力確定時の検索 | 検索文のみをembedding |
| 通常ghqcdの利用 | PoCは呼び出さない |

GitHub同期は検索から分ける。ETag/条件付き取得は帯域削減に使い、304でも通信時間は残ることを記録する。今回のcollectorはREADME/descriptionに限定し、Issue/codeの自動取り込みは次段階とする。将来のIssue同期はpushed_atだけに依存できず、state=all、updated/since、コメントと削除の再照合が必要。
+
+fixtureは取得時点の公開snapshotであり、後の公開→非公開や権限変更をofflineで検知することはできない。削除したdocは再indexで消し、namespace全体はpurgeで除去できる。このPoCを権限同期済みprivate索引として使わない。

## CLIと責務

PoCのCLIは`collect`, `download-model`, `index`, `search`, `evaluate`, `purge`を明示する。モデル取得は`download-model`、GitHub取得は`collect`のみ。その他はローカルファイルだけを読む。各コマンドの成功結果はstdoutのJSON、進捗はstderr。検索結果にrepo・score・出典・chunkの抜粋を含める。検索はclone、cd、shell実行、ブラウザ操作を起こさない。

CLIは単発検索で、常駐daemonを作らない。warm benchmarkは同一processでモデルを保持した測定であり、単発CLIの起動込みとは明確に分ける。
+
+### 入力・実行予算とエラー
+
+| 対象 | 上限 |
+| --- | --- |
+| corpus JSON | 8 MiB、256 doc、各doc UTF-8 64 KiB |
+| query | UTF-8 4 KiB、prefix/special token込み512 tokens |
+| chunk | 各doc 128、全体2048、モデル入力512 tokens |
+| vector | 次元はprofileの固定値、最大2048、全体2048本 |
+| snapshot | 64 MiB、最大返却repo 20件 |
+| model download | 1 profile 4 GiB、個々のHTTP timeout30秒、総期限600秒 |
+| GitHub collect | 256 repo、逐次、最大60 HTTP requests、timeout30秒、retry最大2回 |
+
+file sizeをparse前に確認し、読み込み自体にも上限を設ける。巨大段落はtokenize前にUTF-8 byte上限で止める。空/重複ID、不正qrels、NaN/Inf、次元不一致、zero norm、空query、過長queryを拒否する。corpus空はエラー、lexical検索の0件は成功の空配列。
+
+エラーはstderrのJSONで`E_INPUT`(exit2)、`E_MODEL_MISSING`(3)、`E_INDEX`(4)、`E_LOCKED`(5)、`E_NETWORK`(6)。本文・query・tokenをエラーへechoしない。モデル不足は自動downloadや他方式への置換をせず、明示のdownload-modelを案内する。HTTP失敗では完成したsnapshotを上書きしない。
+
+Python側は次の小さな責務に分ける。

- `core`: 検証、分割、fingerprint、snapshot保存、完全一致/全文/意味順位、評価指標。
- `embeddings`: 固定model registry、ローカルのみのloader、公式query/document処理。
- `cli`: コマンド引数、取得/モデル取得の境界、JSON/stderr、エラー処理。
- `evaluate`: 同じデータ・条件でのモデル比較と測定結果の集計。

重要な保存・無効化・境界はモデルをダウンロードしないunit testで確認する。実モデルを使うintegration testとbenchmarkは明示実行とし、通常CIで巨大downloadを起こさない。

## 性能の測り方

取得時間、モデルdownload時間、初回load、初回index、変更なしindex、一部変更、query embedding、vector比較、全文検索、結果集約、プロセス起動込みを別々に測る。GPUを使う場合は同期してから時計を止める。

実行環境・依存version・device・dtype・batch size・最大入力・chunk数・processed token数・model/fixture hash・メモリ・保存容量を記録する。P50/P95は最低60 query試行から集計し、warmupと測定回を区別する。プロセス再起動を3回測り、OS disk cacheを消していないことを明記する。同時に複数モデルのGPU benchmarkを走らせない。

品質はRecall@1、Recall@5、MRRを言語・corpus・質問種別ごとに集計する。数値だけでなく、Chinese→Japaneseの成功例と失敗例を出典付きで掲載する。一般的な高性能を主張するための閾値を後から捏造しない。

## 安全性の合否

- モデル取得後、外部通信をOSで禁止した状態でindex/search/evaluateが実行できる。
- 知らないmodel profile、浮動revision、remote code、Safetensors以外の重みを拒否する。
- queryやREADMEから任意のコード・URL・shell命令を実行しない。
- private取得を拒否し、token・秘密鍵・検索本文をログへ出さない。端末出力の制御文字を抑制する。
- namespaceを越えるread/write/purge、symlink脱出を拒否する。
- 変更なし・変更・削除・次元不一致・保存途中失敗のテストが通る。
- 暗号化については、ベクトルも機密扱いが必要であること、FileVaultはログイン中の同一権限アプリを隔離しないことを説明する。
- 今回は製品全体の侵入試験や、全OSでの安全性認証を行ったとは表現しない。

## レビューと完了

20原則の初回審査、実測後の再審査、仕様適合とコード品質の独立レビューを行う。重要な指摘を修正して再レビューし、既存テスト・PoCテスト・npm packの内容を確認する。合格していない項目は理由を残し、実測と未検証を区別する。

PR本文は問題、PoCで可能な操作、言語横断の結果、再現コマンド、性能の条件、残る制約を記載する。PRを作成・確認してブラウザで開き、URLを報告する。
