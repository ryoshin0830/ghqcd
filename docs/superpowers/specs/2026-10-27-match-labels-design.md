# 何に当たったかを、1 行ごとに見せる

日付: 2026-10-27（`2026-10-27-unified-search-design.md` の続き）

## 何のためか

利用者の言葉: 「何にヒットしたのかも表示できるようにしてほしい。タイトルなのか、ディスクリプションなのか、issue なのか readme なのか、code なのか。また、直接検索でヒットしたのか、ベクトル検索でヒットしたのかなども。もっと観やすくしてほしい。」

今は `README: …` や `≈ …`、`code: …` の接頭辞が snippet に混ざっていて、行ごとに位置がそろわず、名前・description で当たったものは何も書かれていない。

## ゴール

- 1 行ごとに、**どこに当たったか**（名前 / パス / description / README / issue / コード）と、**どうやって当たったか**（文字の一致か、意味の一致か）が分かる。
- 縦に目で追える（印の列が左端にそろう）。
- 色がなくても（`NO_COLOR`）同じ情報が読める。
- 右のプレビューで、当たった箇所そのもの（前後の行つき）が読める。

## ゴールにしないこと

- 並び順の変更（名前 > description > README > issue > 意味 > コード は利用者の決定）。
- 列を増やす表のような見た目（80×24 と 60 桁で崩れる）。

## 決めたこと（私の判断）

### 行の形

```
name    github.com/ryoshin0830/lj · not cloned
desc    github.com/ryoshin0830/short-url        ショートURL・ファイル転送
readme  github.com/ryoshin0830/ghnew            …the fzf picker…
issue   github.com/ryoshin0830/opencode-web     #5 アイドル sandbox を自動で回収する
~readme github.com/ryoshin0830/portfolio        URL短縮機能をもっと目立つところに
~issue  github.com/ryoshin0830/opencode-web     #6 公開の連打に歯止めをかける
code    github.com/ryoshin0830/ghqcd            bin/ghqcd.mjs:532 function fzfFilter(…
```

- 左端に 7 桁の印（そろえる）。印の言葉:

  | 印 | 当たった場所 | どうやって |
  |---|---|---|
  | `name` | リポジトリ名（完全一致・先頭・部分） | 文字の一致 |
  | `name*` | リポジトリ名（文字が順に含まれる、fzf 風） | 文字の一致（あいまい） |
  | `path` | host / owner を含む `host/owner/name` | 文字の一致 |
  | `desc` | description | 文字の一致 |
  | `readme` | README | 文字の一致 |
  | `issue` | issue のタイトルか本文 | 文字の一致 |
  | `~readme` | 名前・description・README の文章 | 意味の一致（ベクトル） |
  | `~issue` | issue の文章 | 意味の一致（ベクトル） |
  | `code` | コード（手元は git grep、手元にないものは GitHub のコード検索） | 文字の一致 |

- `~` が付くものだけが意味の一致（`≈` は東アジアの曖昧幅で、日本語ロケールで列がずれるので ASCII にした。私の判断）。色は補助（文字の一致はシアン、意味の一致はマゼンタ、コードは黄）。印の言葉だけで区別できる。
- 印の後ろに slug。clone していないものだけ ` · not cloned`（薄い色）。
- 名前・パスで当たったときは、snippet の位置に description を薄い色で出す（当たっていないことが分かるように）。それ以外は、当たった語を太字にした snippet。
- 問い合わせごとのヘッダー行は凡例にする: `“lj” · name path desc readme issue code: the words · ~: by meaning`。

### プレビュー

1 行目に「何にどう当たったか」、そのあとに当たった箇所。

```
github.com/ryoshin0830/opencode-web
matched issue #5 by words
#5 アイドル sandbox を自動で回収する
  …本文の当たった行の前後 3 行…
───
<description>
recent commits …
```

- 意味の一致は `matched README by meaning (similarity 0.62)`。
- 手元のコードは `git grep -n -C 3` で前後の行。手元にないもののコードは、ファイルの場所と「ctrl-o で開く」。
- プレビューには fzf の `{q}` も渡す。

## 作る人に任せること

- 色の具体的な ANSI 番号（16 色の範囲で）。
- 前後の行数（3 行前後）。
