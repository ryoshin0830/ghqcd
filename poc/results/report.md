
### 日本語のみコーパス（用途の質問19問、カッコ内はTop5）

| 方式 | 日本語 R@1 | 中国語 R@1 | 中国語・英字なし R@1 | 英語 R@1 | 中国語 MRR |
|---|---|---|---|---|---|
| lexical | 18/19 (19) | 7/19 (15) | 1/19 (7) | 12/19 (17) | 0.54 |
| e5-small | 18/19 (19) | 16/19 (18) | 9/19 (14) | 17/19 (19) | 0.89 |
| qwen3-0.6b | 19/19 (19) | 19/19 (19) | 19/19 (19) | 18/19 (19) | 1.00 |
| gemma2 | 19/19 (19) | 19/19 (19) | 18/19 (19) | 19/19 (19) | 1.00 |
| bge-m3 | 18/19 (19) | 18/19 (19) | 16/19 (19) | 18/19 (19) | 0.97 |

### 原文コーパス（用途の質問19問、カッコ内はTop5）

| 方式 | 日本語 R@1 | 中国語 R@1 | 中国語・英字なし R@1 | 英語 R@1 | 中国語 MRR |
|---|---|---|---|---|---|
| lexical | 9/19 (13) | 9/19 (15) | 2/19 (5) | 14/19 (17) | 0.60 |
| e5-small | 12/19 (18) | 12/19 (18) | 6/19 (14) | 15/19 (19) | 0.74 |
| qwen3-0.6b | 19/19 (19) | 19/19 (19) | 17/19 (18) | 19/19 (19) | 1.00 |
| gemma2 | 15/19 (19) | 16/19 (19) | 14/19 (18) | 16/19 (19) | 0.92 |
| bge-m3 | 18/19 (19) | 17/19 (19) | 11/19 (18) | 19/19 (19) | 0.94 |

### 似たツールの区別（gwq系・ghq系の5問、日本語のみコーパス、R@1）

| 方式 | 日本語 | 中国語 | 中国語・英字なし |
|---|---|---|---|
| lexical | 4/5 | 2/5 | 0/5 |
| e5-small | 4/5 | 3/5 | 2/5 |
| qwen3-0.6b | 5/5 | 5/5 | 5/5 |
| gemma2 | 5/5 | 5/5 | 4/5 |
| bge-m3 | 4/5 | 4/5 | 3/5 |

### 正解なし質問の識別（日本語のみコーパス、中国語）

| 方式 | 正解あり1位score 中央値 | 正解なし1位score 最大 | AUROC | 全正解を通す閾値で残る正解なし |
|---|---|---|---|---|
| e5-small | 0.851 | 0.820 | 1.00 | 0/5 |
| qwen3-0.6b | 0.668 | 0.437 | 1.00 | 0/5 |
| gemma2 | 0.772 | 0.652 | 1.00 | 0/5 |
| bge-m3 | 0.643 | 0.487 | 1.00 | 0/5 |

### 中国語→日本語のみコーパスで1位を外した質問

| 方式 | 質問 | 正解 | 1位 | 正解の順位 |
|---|---|---|---|---|
| lexical | 想在多台电脑之间同步AI的技能和MCP配置 | syncskills | google-mcp | 4 |
| lexical | 让AI操作Google日历和Gmail的MCP服务器 | google-mcp | grantloom | 2 |
| lexical | 找出扫描书籍中缺页的工具 | page-checker | ccverbs | 20 |
| lexical | 把名单随机分组的命令行工具 | picking | ccverbs | 21 |
| lexical | 想对比多个模型生成的日语朗读语音 | japanese-tts-comparison | short-url | 2 |
| lexical | 把用外币支付的消费记录到Google表格里的记账本 | expense-ledger | google-mcp | 3 |
| lexical | 把Claude Code等待时显示的动词换成自己喜欢的词 | ccverbs | ryoshin0830 | 2 |
| lexical | 新建一个GitHub仓库并同时克隆到本地 | ghnew | ryoshin0830 | 3 |
| lexical | 在当前项目里新建分支和对应的worktree | gwqadd | gwqcd | 3 |
| lexical | 从ghq管理的仓库中选择一个并cd进去 | ghqcd | fzf-ghq-remote | 3 |
| lexical | 把长网址缩短后分享的服务 | short-url | ccverbs | 24 |
| lexical | 用美式键盘左右Command键切换日语和英语输入 | karabiner-lang | ccverbs | 15 |
| lexical | 想让多台电脑上的人工智能助手技能和插件服务器保持同步 | syncskills | ccverbs | 25 |
| lexical | 想把谷歌登录授权得到的访问令牌存进密码管理器 | grantloom | kane | 5 |
| lexical | 让人工智能读写谷歌日历和谷歌邮箱的服务端 | google-mcp | ccverbs | 7 |
| lexical | 想让人工智能搜索并读取微软邮箱里的邮件 | outlook-mcp | ccverbs | 19 |
| lexical | 找出扫描书籍中缺页的工具 | page-checker | ccverbs | 20 |
| lexical | 把名单随机分组的命令行工具 | picking | ccverbs | 21 |
| lexical | 想让音乐文件里的歌曲标题和文件名保持一致 | mp3-album-info-renamer | ghqcd | 18 |
| lexical | 用纯文本标记语言和图表生成演示幻灯片 | markdown_slide | short-url | 18 |
| lexical | 想对比多个模型生成的日语朗读语音 | japanese-tts-comparison | short-url | 2 |
| lexical | 把用外币支付的消费记到谷歌在线表格里的记账工具 | expense-ledger | ccverbs | 2 |
| lexical | 把人工智能编程助手在等待时显示的动词换成自己喜欢的词 | ccverbs | ryoshin0830 | 3 |
| lexical | 在代码托管平台上新建仓库并同时克隆到本地 | ghnew | ccverbs | 4 |
| lexical | 想进入已经创建好的工作树目录 | gwqcd | ccverbs | 10 |
| lexical | 输入拉取请求的链接，就自动创建工作树并进入该目录 | gwqpull | ccverbs | 11 |
| lexical | 在当前项目里新建分支和对应的工作树 | gwqadd | ccverbs | 9 |
| lexical | 从本地统一管理的代码仓库里挑一个并切换到该目录 | ghqcd | kane | 2 |
| lexical | 把长网址缩短后分享的服务 | short-url | ccverbs | 24 |
| lexical | 用美式键盘左右两侧的命令键切换日语和英语输入法 | karabiner-lang | ccverbs | 15 |
| e5-small | 把名单随机分组的命令行工具 | picking | fzf-ghq-remote | 13 |
| e5-small | 想切换到已经创建好的git worktree | gwqcd | gwqadd | 2 |
| e5-small | 从ghq管理的仓库中选择一个并cd进去 | ghqcd | gwqadd | 3 |
| e5-small | 让人工智能读写谷歌日历和谷歌邮箱的服务端 | google-mcp | ghnew | 15 |
| e5-small | 想让人工智能搜索并读取微软邮箱里的邮件 | outlook-mcp | thesis_typst | 9 |
| e5-small | 把名单随机分组的命令行工具 | picking | fzf-ghq-remote | 13 |
| e5-small | 想让音乐文件里的歌曲标题和文件名保持一致 | mp3-album-info-renamer | thesis_typst | 2 |
| e5-small | 把日文和英文参考文献分开排列的论文排版模板 | latex-jp-en-references-template | thesis_typst | 2 |
| e5-small | 用纯文本标记语言和图表生成演示幻灯片 | markdown_slide | thesis_typst | 16 |
| e5-small | 把人工智能编程助手在等待时显示的动词换成自己喜欢的词 | ccverbs | thesis_typst | 4 |
| e5-small | 想进入已经创建好的工作树目录 | gwqcd | gwqadd | 2 |
| e5-small | 输入拉取请求的链接，就自动创建工作树并进入该目录 | gwqpull | fzf-ghq-remote | 2 |
| e5-small | 从本地统一管理的代码仓库里挑一个并切换到该目录 | ghqcd | gwqadd | 6 |
| gemma2 | 想进入已经创建好的工作树目录 | gwqcd | isucon-shin | 2 |
| bge-m3 | 想切换到已经创建好的git worktree | gwqcd | gwqadd | 2 |
| bge-m3 | 让人工智能读写谷歌日历和谷歌邮箱的服务端 | google-mcp | grantloom | 2 |
| bge-m3 | 想进入已经创建好的工作树目录 | gwqcd | gwqadd | 2 |
| bge-m3 | 输入拉取请求的链接，就自动创建工作树并进入该目录 | gwqpull | gwqadd | 2 |

### 性能（MPS / FP32 / batch 4）

| モデル | 取得容量 | 読込 | 索引 日本語のみ (chunk) | 索引 原文 (chunk) | 検索 P50 / P95 | ピークRSS | 単独とbatchの最小cos | 次元・有限・単位norm |
|---|---|---|---|---|---|---|---|---|
| e5-small | 0.46 GiB | 1.0 s | 0.1 s (26) | 1.3 s (149) | 6 / 7 ms | 1.00 GiB | 1.00000 | OK |
| qwen3-0.6b | 1.12 GiB | 2.3 s | 1.5 s (26) | 15.2 s (123) | 25 / 27 ms | 3.73 GiB | 1.00000 | OK |
| gemma2 | 1.42 GiB | 1.3 s | 0.8 s (26) | 9.0 s (127) | 20 / 21 ms | 2.19 GiB | 1.00000 | OK |
| bge-m3 | 2.14 GiB | 3.2 s | 0.8 s (26) | 9.2 s (147) | 20 / 25 ms | 0.89 GiB | 1.00000 | OK |
