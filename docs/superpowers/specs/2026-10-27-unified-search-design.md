# 1 つの検索ウィンドウで、手元と GitHub のリポジトリをすべて探す

日付: 2026-10-27
ブランチ: `poc/multilingual-repository-search`（PR #1）

## 何のためか

`ghqcd` で `lj` と打っても、GitHub にある `ryoshin0830/lj` は手元に clone していないので見つからなかった。
利用者の要件は次のとおり（利用者の言葉）。

- ghqcd では、local の repository の他に GitHub 等の検索もできるようにする。
- 全体で検索ウィンドウは 1 つだけ。複数の TUI にしない。
- 重みは、リポジトリ名 > description > README > issues > code の順。
- ローカルにないリポジトリも検索できる。
- Google 検索のように、1 回の検索ですべてを探せる。使いやすさを最優先にする。

## ゴール

- `ghqcd [query]` が開く 1 つのウィンドウで、手元の clone と、GitHub / GHE で自分がアクセスできるリポジトリを、同じ一覧で探せる。
- 打つたびに結果が更新される（fzf の手触り）。名前で当たるものは打った瞬間に出る。
- 1 件ごとに「なぜ当たったか」が見える（Google の snippet）。
- 手元にないリポジトリを選ぶと、その場で `ghq get` して移動する。
- 前に作った意味検索（中国語の質問で日本語の README が見つかる）も、同じ一覧に混ざる。

## ゴールにしないこと

- `--issues` と `--semantic` という別の画面。両フラグは削除する（未リリースなので互換は不要）。
- 他人のリポジトリ全体の検索（GitHub 全体の検索）。対象は自分がアクセスできるリポジトリだけ。
- 新しいランタイム依存（I9）。fzf と node と ghq と git だけで動く。

## 失敗とみなすこと（anti-goals）

- 今の主な使い方が遅くなる・壊れる。`ghqcd api` で一意なら打鍵なしで移動する、が保てない。
- 名前で一意に当たるのに、README の偶然の一致が上に来る。
- 非公開リポジトリの中身が、頼んでいないのに外に出る・勝手に取得される。

## 決めたこと（利用者が決めた）

- ウィンドウは 1 つ。重みの順（名前 > description > README > issues > code）。
- 手元にないリポジトリも結果に出る。

## 決めたこと（私の判断。利用者に確認していない）

### 結果の並べ方

キーワードの一致を先に、意味だけの一致をその下に、コードの一致を最後に並べる。

1. **キーワードの一致**: 打った語をすべて含むリポジトリ（語ごとに、どこかの欄に一致すればよい。AND）。
   各語について一番重い欄の点数を取り、合計で並べる。

   | 一致した欄 | 点数 |
   |---|---|
   | 名前と完全一致 | 100 |
   | 名前の先頭 | 90 |
   | 名前に含む | 80 |
   | owner や host を含む slug に含む | 60 |
   | 名前のあいまい一致（1 語のときだけ、fzf と同じ部分列） | 40 |
   | description | 30 |
   | README | 20 |
   | issue のタイトル | 12 |
   | issue の本文 | 8 |

   同点なら、clone 済みを先に、次に最近 push されたものを先に。
2. **意味の一致**: キーワードで当たらなかったリポジトリを、ベクトルの類似度順に（今の `semanticRank`。issue は −0.1）。
   cos 0.45 未満は出さない（実装時に 0.35 から変更。識別子のような質問で無関係な表が 0.42 まで来たため）。上位 20 件まで。
3. **コードの一致**: 手元の clone は `git grep`、手元にないリポジトリは GitHub のコード検索 API。最後に並ぶ。

意味とコードは遅いので、キーワードの結果を先に出し、届いた順に一覧の下に足す（後述の仕組み）。

### 1 件の表示（1 行）

```
github.com/ryoshin0830/lj · not cloned   <description>
github.com/ryoshin0830/opencode-web      #5 アイドル sandbox を自動で回収する
github.com/ryoshin0830/short-url         README: …ショートURL・ファイル転送…
github.com/ryoshin0830/gwqcd             ≈ Pick a git worktree managed by gwq …（意味の一致）
github.com/ryoshin0830/ghqcd             code: bin/ghqcd.mjs:812 function fzfPick(…
```

- 先頭は slug（Google のタイトル）。手元にないものだけ ` · not cloned` を付ける（印は例外だけに付ける）。
- その後ろに、当たった欄の snippet。打った語は太字（`NO_COLOR` では装飾なし）。
- 右のプレビュー欄（幅 100 桁以上）に、description、当たった箇所の前後（改行つき）、手元なら最近のコミット。

### 操作

| キー | 動作 |
|---|---|
| 文字を打つ | 結果が更新される |
| Enter | そのリポジトリに移動。手元になければ `ghq get` してから移動 |
| ctrl-o | ブラウザで開く（リポジトリ、issue、コードの行）。ウィンドウは開いたまま |
| ctrl-r | 索引を更新（GitHub のリポジトリ一覧、README、issue、ベクトル） |
| Esc / ctrl-c | 何もせず終わる（exit 130、エラー表示なし） |

ヘッダーは 1 行で、幅に収まる分だけ（優先度: ctrl-r の案内、更新日時、ctrl-o の案内）。
索引がまだないときは「ctrl-r: GitHub のリポジトリ・README・issue も検索する」と案内する。

### 打鍵なしの移動（今の `--select-1` の置き換え）

今それで移動できる問い合わせは、引き続き移動できること（builder check を受けた判断）。

1. clone 済みのリポジトリの中で、名前・slug の部分一致・名前のあいまい一致（今の fzf がパスにしていた一致に相当）で当たるものが 1 件だけなら、移動する。
2. clone 済みに 1 件もなく、clone していないリポジトリの名前一致（100 / 90 / 80）が 1 件だけなら、clone してから移動する。
3. 言葉でどのリポジトリにも当たらないとき（`alweb`、`ali/web`）は、今と同じ `fzf --filter` を clone のパスにかけ、1 件だけなら移動する。`--json` はその先頭を返す。
4. それ以外はウィンドウを開く。

### 仕組み

- 親の `ghqcd` プロセスが索引をメモリに持ち、キャッシュ内（0700）の Unix ドメインソケット（Windows は名前付きパイプ）で待ち受ける。
- fzf は `--disabled`（fzf 自身は絞り込まない）で起動し、`change:reload(<node> <bin> --serve-query <socket> {q})` で、打つたびに子プロセスに問い合わせる。
  子は親から届く行を、そのまま stdout に流す。fzf は届いた行から表示し、次の打鍵で古い子を止める。
- 親は 1 回の問い合わせに対して、キーワードの結果をすぐ返し、意味の結果（モデルは最初の問い合わせで読み込み、以後はメモリに置く）、コードの結果の順に、同じ接続へ追記する。
  接続が切れたら（次の打鍵）、その問い合わせの残りの処理はやめる。
- プレビューも同じソケットに `--serve-preview <socket> {1}` で問い合わせる。
- fzf の `--listen` は使わない。0.38 は API キーがなく、同じマシンの他人が fzf に任意のコマンドを実行させられるため。
- fzf を spawnSync で待つと、親がソケットに答えられない。ウィンドウの間は非同期の spawn にする。

### 索引（`--index` と ctrl-r）

- 索引の単位は「リポジトリ」。キーは、clone 済みなら絶対パス、clone していなければ `host/owner/name`。
- ホストごと（ghq の一覧に出るホストと github.com。gist は除く）に、GraphQL の `viewer.repositories`
  （affiliations: OWNER, COLLABORATOR, ORGANIZATION_MEMBER）を全ページ取る。
  name、description、viewerPermission、pushedAt、isArchived、README の本文（`HEAD:README.md` ほか数種）。
  手元にあるものは README をディスクから読む。
- issue は、書き込み権限のあるリポジトリだけ（今と同じ）。clone していないリポジトリも対象。
- ベクトルは、clone していないリポジトリの README と issue も対象（差分だけ、今の仕組み）。
- 規模の実測: github.com 174 件、社内 GHE 27 件。

### `--json` と `--list`（スクリプトとエージェント向け）

- `--json <query>` は同じキーワード順位で、**clone 済みのリポジトリだけ**から選ぶ（`path` は必ず存在するパス、という契約を守る）。
  clone していないリポジトリしか当たらなかったら `E_NO_MATCH` にし、メッセージに `ghq get <url>` を書く。
- `--list` は今のまま（clone 済みだけ）。

### 意味検索は既定でオン、初回はステータスバーで見せる（利用者の決定、2026-10-27）

- 利用者の言葉: 「ベクトル検索のやつはデフォルトでオンですよ。最初時間かかるかもだけど、ステータスバーとかを用意しよう」。
- `--index`（と ctrl-r）は毎回ベクトルまで作る（ランタイムの導入、モデル 1.2GB の取得、差分の embedding）。`--semantic` フラグは廃止。
- ウィンドウを開いたとき、索引がない・1 日より古い・ベクトルが足りないなら、裏で `ghqcd --index` を低い優先度（nice 19）で起動する。
  ウィンドウはすぐ開き、まず名前で探せる。裏の作成が書き上げるたびに、結果が良くなる。
- 裏の作成は `<cache>/progress.json` に段階・件数・残り時間を書く。親はそれを 0.5 秒ごとに読み、fzf の下部の 1 行（`--footer`）を
  `--listen=<cache>/fzf-<pid>.sock` 経由の `change-footer` で書き換える。書き上がったら `reload` で結果を入れ替える。
- 例: `downloading the search model 43% of 1.2 GB (once)` → `embedding 412/1,800 · about 25 min left` → `indexed just now · ctrl-r refresh · ctrl-o open`。
  失敗は `! GitHub could not be read: HTTP 401 — run gh auth login` のように、何が起きて何をすればよいかを書く。
- `--footer` と Unix ソケットの `--listen` が使えない fzf（Debian の 0.38 など）では、開いた時点の状態を固定のヘッダーに出すだけにする（判定は起動前に `fzf --filter` で試す。27 ミリ秒）。
- ウィンドウを閉じても裏の作成は続ける。閉じたとき、続いていることを stderr に 1 行で知らせる。途中で止まっても次回は続きから。
- ctrl-r は、新しい fzf ではウィンドウを開いたまま裏の作成を始める。古い fzf では、今までどおり閉じて更新して開き直す。
- `--json` / `--list` / `--quiet`（端末なし）では、裏の作成を自動で始めない。

### コード検索で GitHub に問い合わせるタイミング（builder check を受けた判断）

- 検索欄に打つこと自体を「検索を頼んだ」とみなす。要件が「1 回の検索でコードまで探す」だから。
- 手元の clone は `git grep`（通信なし）。GitHub のコード検索 API に送るのは、clone していないリポジトリのためだけで、入力が 0.7 秒止まってから、自分のトークンで、1 分に 10 回まで。
- README と CLAUDE.md の「検索は手元で完結する」という説明は、これに合わせて書き換える。

## 制約

- CLAUDE.md の不変条件。特に I1（stdout は機械向け）、I4（fzf の UI は stdout に出さない）、I5、I6、I7、I9。
- fzf 0.38（Debian 12）で動くこと。`--disabled`、`change:reload`、`--expect`、`--print-query`、`--ansi` はすべて 0.38 にある。
- テストは通信なし・TTY なし。順位づけは純粋関数にして単体テストする。

## 作る人に任せること

- 点数の細かい調整（同じ順序を保つ範囲で）。
- 子プロセスと親のやり取りの形式（1 行 1 結果の改行区切りで十分なはず）。
- `git grep` を同時に何本走らせるか。GitHub のコード検索を何ミリ秒の静止で始めるか（10 回/分の制限に収まること）。
