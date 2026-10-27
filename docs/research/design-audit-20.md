# 多言語リポジトリ検索PoC：設計20原則の独立審査

審査日: 2026-10-26。対象: [設計書・第2版](../superpowers/specs/2026-10-26-multilingual-search-poc-design.md)。参照: [タスクリスト](poc-tasks.md)、[モデル調査](model-survey-2026-10.md)、[CLAUDE.md](../../CLAUDE.md)、[package.json](../../package.json)。

**判定: 20項目とも設計は妥当。初回の重要指摘7件は設計上解消し、実装前に残る重大・重要な設計上の阻害要因はない。** これは公開データだけを扱う単一OSユーザー向けPoCを実装できるという判定であり、実装・実行時の合格判定ではない。ユーザーの設計承認は別途保留中であり、本審査は承認を代替しない。

本審査では設計と関連文書を読んだ。コード実行、モデル取得、推論、性能測定、OSによる通信遮断テストは行っていない。モデル調査の一次資料を本審査で独立に再取得したわけでもない。モデルの実際の互換性、前処理の正しさ、安全性、速度と精度は実装後に証拠を取得して再審査する。

## 初回の重要指摘と解消内容

| # | 初回の重要な不足 | 第2版での具体的な解消 | 現在の状態 |
| --- | --- | --- | --- |
| 1 | 採点前に固定する範囲が狭く、tokenizer別分割・repo集約・RRF・負例の扱いが不明確だった。 | 全方式の採点前にcorpus、派生説明、alias、3言語query、qrels、全文パラメータ、集約、RRFを固定する。全repoを関連性判断の候補にする。tokenizer込みのend-to-end比較と明記し、chunk数・本文露出量を報告する。repo内max、ID順tie-break、上位10件・k=60・等重みRRFを固定する。先行結果を見た探索的データであることも開示する。 | 設計上解消。凍結artifactと実測の照合は未実施。 |
| 2 | 公式のモデル処理が方針に留まり、Gemma2のtext-only loader、projection、安全なmodule loadingを再現できなかった。 | 4モデルのSHA、依存version、完全なquery/document template、次元、padding、pooling、projection、正規化をprofileに固定する。Gemma2は公式text-only構成を指定する。STの許可classは6つの完全一致パスに限定する。local snapshot、local_files_only、trust_remote_code=False、use_safetensors=Trueを必須とし、pickle fallbackとモデルrepoのPythonを禁止する。 | 設計上解消。公式経路との一致・単独/batch一致・実機対応は未検証。 |
| 3 | 巨大入力とdownloadを抑える具体的な予算がなかった。 | corpus、doc、query、chunk、vector、snapshot、返却数、download容量・期限、HTTP回数・timeout・retryに上限を設定する。parse前の検査と実際のstream受信byte数の制限を併用し、Content-Lengthだけに依存しない。NaN/Inf、zero norm、重複ID、不正qrelsなどを拒否する。Issue/code収集は対象外にする。 | 設計上解消。境界値・超過・不正入力テストは未実施。 |
| 4 | 任意のローカルJSONの自己申告から「公開データ」と保証することはできなかった。 | index/evaluateをチェックインしたmanifestのdataset ID・SHAに一致する公開fixtureに限定する。collectは匿名の公開GitHub APIとprivate=false確認を使用し、任意URL・local repo走査を受け付けない。出典種別、revision、取得時刻、派生説明の元出典を記録する。 | 設計上解消。実fixtureの公開性・出典・hash検証は未実施。 |
| 5 | atomic replaceだけでは複数ファイルの世代混在、purge競合、古いlock、symlink逸脱を防げなかった。 | メタデータ・chunk対応・vectorを単一JSON snapshotにまとめ、同一filesystemの一時ファイルからreplaceする。index/purgeで同じflockを用い、purgeはlock inodeを残す。O_DIRECTORY/O_NOFOLLOWとdirfd相対操作を使う。保証をprocess中断時の完成世代保持に限定し、電源断耐久性や同一権限アプリからの完全隔離を主張しない。 | 設計上解消。競合・途中失敗・symlink・権限テストは未実施。 |
| 6 | 正解なしqueryの指標と、通信失敗・モデル不足・空結果の振る舞いが曖昧だった。 | 正例のrepo単位Recall@k・MRRとmacro平均を定義する。負例は件数・非空結果率・score/近傍を別集計し、未校正の棄却性能を主張しない。安定したエラーcodeとexit codeを定義し、モデル不足時の自動download・方式置換を禁止する。空corpusはエラー、lexicalの0件は成功の空配列とする。 | 設計上解消。指標の既知例テストとCLI失敗系は未実施。 |
| 7 | cacheの全profile fingerprintに含まれる数値条件が不明確だった。 | model/tokenizer revision、prompt、pooling/projection/normalization、dimension、dtype/backend policy、adapter version、chunk設定、固定依存versionとformat済み入力hashを明記する。条件変更時は古いvectorを混ぜない。 | 設計上解消。各条件の無効化・再利用回数・不整合拒否は未検証。 |

再審査時の補足も反映済み。許可classはnamespace wildcardではなく完全一致リストとなり、streamの実byte数へ制限を適用し、更新・削除の検証には評価集合と別のmutation fixtureを使う。設計書の不要な行頭`+`も除去されている。

## 20原則の判定と実装時に必要な証拠

「設計妥当」は要件と対策が実装に十分という意味。「実装証拠・再審査」は全項目が未完了であり、設計文書の存在だけでは合格に変更しない。

| # | 原則 | 設計判定 | 実装時に必要な証拠 | 実装証拠・再審査 |
| --- | --- | --- | --- | --- |
| 1 | 目的と合否基準 | 設計妥当 | 完成条件の照合、中国語→日本語の成功・失敗例と測定値。この小規模実験を越える最適性・精度を主張しない。 | 未取得・未審査 |
| 2 | 最小の範囲 | 設計妥当 | 独立PoC、exact scan、単発CLI。daemon・vector DB・Issue/code collectorを追加していないこと。 | 未取得・未審査 |
| 3 | 既存契約の保全 | 設計妥当 | 既存CLIテスト、bin/ghqcd.mjsとruntime npm依存の保全、npm packでPoC・data・weightsを含まないこと。 | 未取得・未審査 |
| 4 | 責務の分離 | 設計妥当 | 通信処理がcollect/download-modelだけに到達可能で、local loader・保存・検索・評価が分離していること。 | 未取得・未審査 |
| 5 | 出典と正規形 | 設計妥当 | source_kind、commit/blobまたはsnapshot hash、取得時刻、visibility、派生文書の元出典が検証可能なmanifest。 | 未取得・未審査 |
| 6 | 入力検証 | 設計妥当 | 事前size検査とbounded read/stream、上限境界値、巨大入力、重複ID、不正qrels、NaN/Inf・shape・norm、path/symlinkの拒否テスト。 | 未取得・未審査 |
| 7 | モデル処理の正しさ | 設計妥当 | 固定profile、format済み入力とtoken数、公式経路との数値一致、単独/batch一致、Gemma2 text-onlyとprojection保持。 | 未取得・未審査 |
| 8 | 分割と情報保持 | 設計妥当 | 日本語・長段落・境界入力の情報保持、prefix/special token込み上限、重複量、黙ったtruncateがないこと。 | 未取得・未審査 |
| 9 | 差分更新と無効化 | 設計妥当 | 同一入力のembedding呼出し0、変更部分のみ再処理、削除反映、全fingerprint要素の無効化。mutation fixtureは評価集合と分離する。 | 未取得・未審査 |
| 10 | 保存の整合性 | 設計妥当 | 中断注入、並行writer、purge/index競合、破損snapshot、次元不一致。readerが旧版か新版の完成世代だけを読むこと。 | 未取得・未審査 |
| 11 | 鮮度と権限 | 設計妥当 | 静的公開snapshotという制約、公開→非公開をoffline検知できないことの説明、削除/reindex、account/namespace分離。 | 未取得・未審査 |
| 12 | ローカル処理と最小収集 | 設計妥当 | 匿名public collector、fixture hashの許可検査、実際のindex/search/evaluateがOS外部通信禁止下で成功すること。 | 未取得・未審査 |
| 13 | 保存と削除の安全性 | 設計妥当 | 管理directory・一時ファイルを含む0700/0600、symlink拒否、namespace外を削除しないpurge、lock inode保持。完全消去・同一権限隔離の限界を説明する。 | 未取得・未審査 |
| 14 | 供給元とライセンス | 設計妥当 | revision/artifact・依存lock・license記録、完全一致module allowlist、safetensors-only、未知module/不完全snapshot/pickle fallback拒否。 | 未取得・未審査 |
| 15 | 検索データと命令の分離 | 設計妥当 | 命令風README/queryが不活性なこと、shell/URL実行や検索副作用がないこと、端末制御文字のescapeと安全なエラー出力。 | 未取得・未審査 |
| 16 | 言語横断の妥当性 | 設計妥当 | 全方式採点前の凍結hash、日本語文書の監査、全repoへの関連性判断、3言語の意図/qrels一致、探索的データであることの明示。 | 未取得・未審査 |
| 17 | 比較の公平性 | 設計妥当 | 固定ranking/RRF、共通原文/query/qrels、tokenizer別chunk数と露出量、device/dtype条件、量子化参考値の分離。 | 未取得・未審査 |
| 18 | 時間と資源の測定 | 設計妥当 | 処理段階別時間、GPU同期、60回以上のquery試行、warmup分離、3回のprocess起動、メモリと保存容量。warm測定を単発CLI性能と混同しない。 | 未取得・未審査 |
| 19 | 失敗とフォールバック | 設計妥当 | error/exit code、timeout/retry/容量制限、モデル不足・通信失敗・空結果、暗黙のdownload/方式置換がないこと、負例の独立集計。 | 未取得・未審査 |
| 20 | 再現と独立レビュー | 設計妥当 | 正確な再現コマンド、環境lock、fixture/profile hash、test log、仕様適合・品質の独立再レビュー、PRとchecksの記録。 | 未取得・未審査 |

## 実装後の再審査条件

各行に証拠のパス・実行条件・結果を追記してから実装判定を行う。未検証、除外、不合格は理由を残し、合格した実測と区別する。特に、公式loaderが指定環境で動くこと、OS通信遮断、保存競合、完全なcache無効化、評価データの凍結は文書の宣言から実行時合格へ読み替えない。

モデル非対応などで設計を変更した場合は変更理由と比較条件への影響を記録する。評価結果を見た後の調整は探索的結果として分離し、重要な問題が見つかった場合は修正と独立再レビューを完了する。製品への統合判断、全OSの安全性認証、一般的な最良モデルの保証はこの審査の対象外である。
