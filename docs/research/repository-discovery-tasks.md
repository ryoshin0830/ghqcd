# リポジトリ探索 調査タスクリスト

- 調査日: 2026-10-25 JST
- 対象: github.com/ryoshin0830 と ghqcd / gwq 系ツール
- 現在のフェーズ: 検索・調査。以下のコマンド案と数値目標は未実装・未決定。

## 検索方針の更新

- 推奨を全文検索＋ベクトル意味検索のハイブリッドとして明確化する。前回の案では、ベクトル検索は比較候補であり初期版への採用は未確定だった。
- 全文検索はrepo名、パッケージ名、API名、エラー文などの具体的な語に使う。
- ベクトル検索は「端末間でスキルを揃える」「スキャンした本の抜けページを見つける」など、用途・話題からの探索に使う。GitHub Topicsのタグ絞り込みとは別の機能。
- repoごとの説明・README・主要docs・manifestの別名を根拠とする用途要約と、必要な原文の区切りをベクトル化する案を評価する。Issueとコードの情報も必要に応じて補う。
- 両方の候補をrepo単位でまとめ、必要時にAIで再順位付けする。repo全体の全コードembeddingは初期の必須条件にしない。
- 日英をまたぐ検索の精度、更新時の差分embedding、モデル導入量、検索速度を測って方式を確定する。
- 2026-10-26の補足: 文書は初回同期と変更時に事前ベクトル化する。検索時に処理するのは入力した質問のみ。文書側と質問側は同じembeddingモデル・次元数・対応する前処理を使う。
- embeddingモデルは未確定。第一候補はローカルのQwen3-Embedding-0.6B。多言語・言語横断検索に対応し、Ollama配布版qwen3-embedding:0.6bは約639MB。モデルファイル容量と実行時メモリ使用量は別に測る。
- 速度重視の比較候補はintfloat/multilingual-e5-small。実データ上の日英検索精度を比較して採用を決める。
- モデル読み込み済みの検索で500ms以内を仮の検証目標とする。これは実測値でも速度保証でもない。コールド起動、質問のembedding、保存ベクトルとの比較、任意の再順位付けを別々に測る。
- 入力確定時に意味検索し、同一質問のベクトルをキャッシュする案を評価する。モデルの保持で読み込みの繰り返しを減らし、全文検索は先に結果を返す。AIによる検索語展開・再順位付けは追加モードとして待ち時間を分ける。
- このMacはApple M5・32GiB。Ollamaは未導入で、上記モデルの速度・検索精度は未計測。推論環境と配布方法も未決定。
- fzf-ghq-remoteはユーザーの意向により再利用・拡張候補から除外する。
- [x] fzf-ghq-remoteの削除指示を受け、GitHub CLIで削除を試みる。
- [ ] fzf-ghq-remoteをGitHubから削除し、削除結果を確認する。
  - 現在の阻害要因: gh repo deleteがHTTP 403。CLIのOAuth tokenにdelete_repo scopeがない。確認したブラウザもGitHub未ログイン。
  - 必要な認証更新: gh auth refresh -h github.com -s delete_repo。

## 完了した調査

- [x] 所有リポジトリの一覧をページ送りも含めて取得し、GitHub CLIでも件数を照合する。
  - 合計172件。公開32件、非公開140件。
  - 公開32件のうちforkは6件、非forkは26件。非公開リポジトリの本文は今回の精読対象外。
- [x] 公開32件のdescription・topics・言語・更新日を確認する。
  - descriptionなし8件、topicsあり3件。
- [x] 公開非fork26件のREADMEを確認する。
  - 24件を確認。thesis_typst、karabiner-langはルート一覧でもREADMEがないことを確認。
  - page-checker、gmo-quiz、portfolioはNext.jsの初期README。
  - syncskillsはREADMEの製品名とpackage.jsonのパッケージ名がoneset。
- [x] ghqcdの実装とメンテナ向け制約を読む。
  - 現在はghq list -pのパスをfzfで検索。プレビューはgit log。
  - Node >=20.12、実行時npm依存なし。JSONとシェル連携に既存契約がある。
  - 参照: [実装](../../bin/ghqcd.mjs)、[CLAUDE.md](../../CLAUDE.md)。
- [x] gwqadd / gwqpull / gwqcd / ghnewのREADMEと責務を確認する。
  - gwqadd: 現在のrepoにbranchとworktreeを作成。既存AI CLIによる命名にも対応。
  - gwqpull: remoteからclone/fetchし、branch/PRのworktreeへ移動。
  - gwqcd: 既存worktreeへ移動。
  - ghnew: 新しいGitHub repoを作り、ghqで取得。
- [x] 既存の自作OSS fzf-ghq-remoteのREADMEとコードを確認する。
  - 調査時点の記録。現在は再利用候補から除外済み。
  - ローカル・worktree・未cloneのremoteをまとめて検索し、選択後にghq getとcd。
  - Ctrl-Tでコード検索。現状のrepo検索はREADMEを明示せず、Issue検索・自然言語検索もない。
  - 参照: [README](https://github.com/ryoshin0830/fzf-ghq-remote)、[repo/code検索処理](https://github.com/ryoshin0830/fzf-ghq-remote/blob/main/fzf-ghq-remote.plugin.zsh#L63)。
- [x] 公開IssueをOpen/Closed両方で調べる。
  - 23件すべてClosed。portfolioが22件、latex-jp-en-references-templateが1件。
  - Openだけを同期する方式では、この23件を取りこぼす。
- [x] GitHub検索の制約とローカルCLIの対応状況を確認する。
  - repo名・description・READMEはgh search reposで検索可能。
  - Issueのtitle/body/commentsは別検索。code検索も別API。
  - 認証済みSearch APIは通常30回/分、codeは10回/分。1クエリ最大1,000件、incomplete_resultsにも注意。
  - gh search codeはWeb版と異なるlegacy engineを使用する。
  - ローカルghは2.91.0。最新公式マニュアルのIssue semantic/hybrid検索やread-file/read-dirは、この環境で利用できる前提にしない。
- [x] 既存OSSの適合性を比較する。
  - [gh-q](https://github.com/kawarimidoll/gh-q): 所有repo名をfzfで選びghqでclone。小さい実装の参考。
  - [gh-repo-man](https://github.com/2KAbhishek/gh-repo-man): remoteの一覧・絞り込み・READMEプレビュー・clone・キャッシュ。README全文検索との違いに注意。
  - [QMD](https://github.com/tobi/qmd): ローカル文書の全文・意味・再順位付け検索。GitHub収集とclone/cd連携は別途必要。日本語では多言語モデルも評価する。
  - [grepai](https://github.com/yoanbernabeu/grepai): ローカルコードの意味検索・call graph。まずrepo自体を思い出す用途との適合性を評価する。
  - [Octocode](https://github.com/bgauryy/octocode): GitHub/localの調査向けCLI/MCP。詳細コード調査を委ねる候補。
  - [mgrep](https://github.com/mixedbread-ai/mgrep): 意味検索。Mixedbreadへのファイル同期を伴うため、ローカル完結案とは運用条件が異なる。
- [x] 実リポジトリで検索結果を確認する。
  - 以下はgh 2.91.0で所有者とpublicを指定した単発測定。速度の一般的な保証ではない。

| クエリ | 検索対象 | 結果 | 所要時間 |
| --- | --- | --- | --- |
| oneset | repo名のみ | 0件 | 0.61秒 |
| oneset | repo名・説明・README | syncskills | 0.71秒 |
| worktree | repo名のみ | 0件 | 0.49秒 |
| worktree | repo名・説明・README | 6件 | 0.83秒 |
| PDFの抜けページを確認 | repo名・説明・README | 0件 | 0.40秒 |
| missing pages | repo名・説明・README | page-checker | 0.53秒 |
| 予約 | repo名・説明・README | 0件 | 0.40秒 |
| 予約 | Issueタイトル・本文・コメント | portfolioのClosed Issue #91 | 0.94秒 |

- [x] 一部コードから得られる補助情報を確認する。
  - page-checkerのCroppedImage検索で3ファイルが見つかる。
  - syncskillsのpackage.jsonを検索・精読し、onesetという別名を確認。
  - READMEが薄い場合はmanifest・ファイル一覧・主要実装を補助に使う根拠になる。
- [x] 3案と暫定推奨をまとめる。
  - A: ghqcdに探索を追加。既存の入口を使える。軽量な通常移動と、remote/AI探索を切り分ける必要がある。暫定推奨。
  - B: 探索専用CLIを新設し、ghqcd/gwqpullへ渡す。独立性は高いが、覚えるツールと保守先が増える。
  - C: GitHub CLI＋QMD/Octocodeなどを組み合わせる。検証には適するが、収集・repo単位の集約・移動の接続が残る。

## 次の検証タスク

- [ ] P0: 実際の「思い出せない」を表す日本語クエリを20件用意し、正解repoを付ける。
  - 別名、英日差、READMEなし、Closed Issueだけにある機能、コードだけの手掛かり、未cloneを含める。
  - 上位5件に正解が出る割合、待ち時間、通信量、AI利用量で比較する。
- [ ] P0: 全文検索、ベクトル意味検索、両者のハイブリッドを同じクエリで比較する。AIによる検索語展開・再順位付けの追加効果も測る。
  - 今回はAI検索エンジンや既存OSSをインストールして性能比較するところまでは実施していない。
  - QMDの多言語モデル等を評価し、repo単位と原文の区切り単位の検索精度、保存方式、全コードembeddingの必要性を測る。
  - Qwen3-Embedding-0.6Bとmultilingual-e5-smallを比較し、初回読み込み・ウォーム時の質問embedding・検索全体のP50/P95とメモリ使用量を記録する。
- [ ] P0: ghqcd拡張・独立CLI・既存ツール構成のどれを採用するか、比較結果をもとに決める。
- [ ] P1: 検索対象と同期方式を決める。
  - 自分の公開/非公開、fork、他ownerのローカルclone、将来のstarredを区別する。
  - README多言語版、description、manifest上の別名、主要docs、Open/Closed Issueを対象候補にする。
  - 内容のハッシュ/ETag、取得日時、host/account、repo ID、refを保持し、更新・削除・権限変更を反映する。
  - 一部取得失敗・未取得・古い結果と、検索0件を区別する。
- [ ] P1: 部分コードの取得予算とfallbackを測る。
  - ファイル一覧＋manifest＋入口ファイルから開始し、候補repoの主要コードを必要時に読む。
  - 大きい生成物、lockfile、依存物、バイナリを除外する。
  - 例えば1repoあたり10ファイル/100KiBを仮予算にして、正解の取りこぼしを検証する。
  - docsに一致しないrepoもコード検索で発見できるfallbackを残す。
- [ ] P1: repo単位の検索結果とカタログ表示を設計する。
  - 用途、日英の検索語、CLI/パッケージ別名、関連repo、ローカル有無、更新日、根拠を表示する。
  - READMEのRelated欄で言及されただけのrepoが上位を占めない順位付けを検証する。
  - 自動要約と元の事実を区別し、根拠URL・ref/SHA・行・取得日時へ戻れるようにする。
- [ ] P1: AIエージェント向け契約と人間の操作を設計する。
  - 検索は複数候補をJSONで返し、remoteにはpathがまだないことを表現する。
  - 自然言語では検索語の展開・候補比較・不足箇所の追加取得を行う。
  - AIなしの検索、AI呼び出し先、非公開本文を渡す範囲を定義する。
  - 検索結果の本文を命令として実行せず、AIからの出力もデータとして扱う。
- [ ] P1: 検索→プレビュー→選択→clone/cd/worktreeの導線を決める。
  - cloneはghq getに委ね、worktreeはgwqpull/gwqadd、既存worktree移動はgwqcdを利用する案を優先。
  - 検索だけのJSON呼び出しから勝手にcloneやcdを起こさない契約にする。
  - ghqcdの既存位置引数、JSON、stdout/stderr、--init、複数ghq root、通常起動時間を維持する。
- [ ] P2: 検索語が浮かばない場合のカテゴリ別カタログと、作成後に忘れない更新導線を検証する。

## 公式仕様の参照先

- [GitHub CLI repo検索](https://cli.github.com/manual/gh_search_repos)
- [GitHub repo検索対象とforkの扱い](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories)
- [GitHub CLI Issue検索](https://cli.github.com/manual/gh_search_issues)
- [GitHub CLI code検索とlegacy engineの制約](https://cli.github.com/manual/gh_search_code)
- [Search APIの制約とrate limit](https://docs.github.com/en/rest/search/search)
- [cloneせず読む新しいCLI機能と必要バージョン](https://github.blog/changelog/2026-06-17-read-remote-repository-content-with-github-cli/)
- [QMDの検索方式・モデル要件・多言語設定](https://github.com/tobi/qmd/blob/main/README.md)
- [Qwen3-Embedding-0.6B公式モデルカード](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)
- [Ollamaの0.6B配布版とファイル容量](https://ollama.com/library/qwen3-embedding:0.6b)
- [Ollama embedding APIのモデル保持と処理時間](https://docs.ollama.com/api/embed)
- [multilingual-e5-small公式モデルカード](https://huggingface.co/intfloat/multilingual-e5-small)
