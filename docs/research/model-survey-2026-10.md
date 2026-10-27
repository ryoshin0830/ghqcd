# Local multilingual embedding model survey

Researched at: **2026-10-26 (Asia/Tokyo)**.
Target: Chinese queries retrieving Japanese repository documentation on an Apple M5 Mac with 32 GiB RAM.
Status: research documentation before design approval; no model installation or inference was performed for this survey.

## Recommendation

Compare **multilingual-e5-small, Qwen3-Embedding-0.6B, EmbeddingGemma 2 text-only, and BGE-M3 dense-only** first.
E5 and BGE provide established baselines; Qwen and Gemma 2 provide newer contenders.
All four have upstream implementations that can load without model-repository Python code.
Their sizes make bounded-length, bounded-batch inference plausible within 32 GiB; this is not a measured memory or speed claim.
Do not select a winner from download counts or an overall multilingual benchmark score.

## Eight-family comparison

Dimensions below describe a single dense vector unless stated otherwise. MRL means trained dimension truncation.

| Family and primary model cards | Architecture / size | Context / output | Retrieval processing | License and loading constraints |
| --- | --- | --- | --- | --- |
| [Qwen3 Embedding](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), including [4B](https://huggingface.co/Qwen/Qwen3-Embedding-4B) | Qwen3 causal decoder; 0.6B / 4B | 32K; 1024 / 2560d; MRL | Query instruction, raw documents; last nonpadding token; L2 normalization | Apache-2.0; ungated; native Transformers; official GGUF available |
| Jina v5 text [nano](https://huggingface.co/jinaai/jina-embeddings-v5-text-nano) / [small](https://huggingface.co/jinaai/jina-embeddings-v5-text-small) | EuroBERT / Qwen3 backbones; advertised 239M / 677M including adapters | 8K / 32K; 768 / 1024d; MRL | Retrieval adapter; Query / Document prefixes; last-token pooling; L2 normalization | CC-BY-NC-4.0; ungated; ordinary Python loaders require remote code; commercial use needs separate terms |
| Google [EmbeddingGemma-300M](https://huggingface.co/google/embeddinggemma-300m) / [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2) | Gemma3-derived 300M / Gemma4-derived 270M text-only, 740M all-modalities | 2K / 8K; 768d; MRL | Search-query and title/text prompts; mean pooling plus learned projections; normalize | Original: Gemma terms and HF acceptance gate. Version 2: Apache-2.0, ungated; native upstream code |
| [Nomic Embed v2 MoE](https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe) | NomicBERT; 475M total, 305M active; 8 experts, top-2 routing | 512; 768→256d MRL | search_query / search_document prefixes; masked mean; L2 normalization | Apache-2.0; ungated; Python requires remote code; official GGUF offers another runtime |
| [BGE-M3](https://huggingface.co/BAAI/bge-m3) | XLM-R encoder; approximately 568M | 8192; 1024d | No prefixes; CLS pooling for dense output; normalize | MIT; ungated; native Transformers/ST; dense, sparse, and ColBERT modes are distinct outputs |
| [Multilingual E5 small](https://huggingface.co/intfloat/multilingual-e5-small/raw/main/README.md) | Multilingual MiniLM/BERT; approximately 118M | 512; 384d | query / passage prefixes, including non-English text; masked mean; normalize | MIT; ungated; native Transformers/ST; established lightweight baseline |
| [Snowflake Arctic Embed L v2.0](https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0) | XLM-R; 568M total | 8192; 1024→256d MRL | Query prefix only; CLS pooling; L2 normalization | Apache-2.0; ungated; native Transformers/ST; established alternative to BGE |
| Perplexity [pplx-embed-v1-0.6b](https://huggingface.co/perplexity-ai/pplx-embed-v1-0.6b), [v2-late-0.6b](https://huggingface.co/perplexity-ai/pplx-embed-v2-late-0.6b) | V1: bidirectional diffusion-pretrained Qwen3. V2-late: Qwen3.5-based ColBERT | V1: 32K, 1024d. V2-late: 128d per token | V1: no prefixes, mean pooling, unnormalized INT8 output, cosine scoring. V2-late: query/document markers and MaxSim | MIT; V1 Python requires remote code. V2-late exports native modules but changes index and scoring semantics |

Jina v5 was released February 18, 2026; EmbeddingGemma 2 was released October 6, 2026.
See the [Jina release article](https://jina.ai/en-US/news/jina-embeddings-v5-text-distilling-4b-quality-into-sub-1b-multilingual-embeddings/) and [Google release history](https://ai.google.dev/gemma/docs/releases).
The Jina nano card contains a general 32K prose claim but its specification table and vendor model page give **8192**; use the model-specific limit.
Jina's advertised totals include adapters; HF base-safetensor summaries are smaller. Do not mix counting conventions.

## Frozen first-comparison revisions

These exact upstream revisions were returned by the HF model API on the research date.
They pin weights, tokenizer files, prompts, and Sentence Transformers module configuration together.

| Candidate | Upstream revision | Native architecture | Full output |
| --- | --- | --- | --- |
| [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3) | `614241f622f53c4eeff9890bdc4f31cfecc418b3` | `BertModel` | 384d |
| [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3) | `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3` | `Qwen3ForCausalLM` backbone | 1024d |
| [google/embeddinggemma-2](https://huggingface.co/google/embeddinggemma-2/tree/914f7f89142e33e77833254d9c9b90c3cef7303b) | `914f7f89142e33e77833254d9c9b90c3cef7303b` | `EmbeddingGemma2Model` | 768d |
| [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3/tree/5617a9f61b028005a4858fdac845db406aefb181) | `5617a9f61b028005a4858fdac845db406aefb181` | `XLMRobertaModel` | 1024d |

### E5 contract

- Query: `query: {query}`; document: `passage: {document}`. Preserve case and spaces for Chinese and Japanese inputs too.
- Apply attention-mask-aware mean pooling, then L2-normalize.
- Limit the complete prompted input to 512 tokens; report truncation rather than silently equating it with longer-context models.
- FP32 is a suitable unquantized reference; lower precision is a separate recorded condition.
- Keep `trust_remote_code=False`; native BERT and the repository's ST pooling configuration suffice.

Sources: [official usage and FAQ](https://huggingface.co/intfloat/multilingual-e5-small/raw/main/README.md), [pooling configuration](https://huggingface.co/intfloat/multilingual-e5-small/blob/614241f622f53c4eeff9890bdc4f31cfecc418b3/1_Pooling/config.json).

### Qwen contract

The upstream default query prefix is:

```text
Instruct: Given a web search query, retrieve relevant passages that answer the query
Query:{query}
```

- Documents have no instruction prefix. Do not apply a chat template.
- Pool the last nonpadding token, then L2-normalize; use the pinned tokenizer and its special-token processing.
- An English task instruction is the vendor recommendation even in multilingual contexts.
- Native Transformers requires at least 4.51.0; the checkpoint weights are BF16. Record the actual compute dtype.
- Keep `trust_remote_code=False`; use the embedding pooling pipeline rather than generated text or a language-model head output.

Sources: [model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), [exact ST prompts](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/config_sentence_transformers.json).

### EmbeddingGemma 2 contract

- Query: `task: search result | query: {query}`; document: `title: {title} | text: {content}`.
- Use `title: none` if a title is unavailable; avoid adding the default document prefix to an already formatted document.
- ST prompt names are `SearchQuery` and `Document`; mean pooling includes prompt tokens, followed by L2 normalization.
- Load text-only with `config_kwargs={"vision_config": None, "audio_config": None}` to omit unused modality encoders.
- **Activations do not support FP16.** Use FP32 or supported BF16; record the dtype explicitly.
- Keep `trust_remote_code=False`; native upstream Transformers and ST modules implement the model.
- ST must be at least 6.1.0. Native implementation is verified in the released Transformers 5.20.2 source.

Sources: [Google developer guide](https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/), [pooling and precision documentation](https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers), [pinned prompts](https://huggingface.co/google/embeddinggemma-2/blob/914f7f89142e33e77833254d9c9b90c3cef7303b/config_sentence_transformers.json), [released native implementation](https://github.com/huggingface/transformers/blob/v5.20.2/src/transformers/models/embedding_gemma2/modeling_embedding_gemma2.py).

### BGE-M3 contract

- Query and document inputs are plain text: no instruction or role prefixes.
- Use CLS pooling for dense vectors and explicitly L2-normalize before dot-product ranking.
- Evaluate dense-only initially; adding its sparse or per-token outputs would change retrieval and scoring.
- FP32 is a suitable unquantized reference; record any lower-precision execution separately.
- Keep `trust_remote_code=False`; native XLM-R and the provided ST modules suffice for dense embeddings.

Sources: [official model card and instruction FAQ](https://huggingface.co/BAAI/bge-m3), [CLS pooling configuration](https://huggingface.co/BAAI/bge-m3/blob/5617a9f61b028005a4858fdac845db406aefb181/1_Pooling/config.json).

## Current libraries and Apple Silicon execution

| Component | Version or verified capability on research date | Primary source |
| --- | --- | --- |
| Transformers | Stable 5.20.2, published October 19, 2026 | [release](https://github.com/huggingface/transformers/releases/tag/v5.20.2) |
| Sentence Transformers | Stable 6.2.0, published October 21, 2026 | [release](https://github.com/huggingface/sentence-transformers/releases/tag/v6.2.0) |
| PyTorch | MPS provides a Metal backend; CPU is an alternative; device support must be checked locally | [official MPS documentation](https://docs.pytorch.org/docs/2.14/notes/mps.html) |
| llama.cpp | Apple Silicon support through Metal, Accelerate and ARM NEON | [upstream README](https://github.com/ggml-org/llama.cpp) |
| MLX Embeddings | BERT, XLM-R and Qwen3 implementations; separate GPLv3 runtime dependency | [runtime repository](https://github.com/Blaizzy/mlx-embeddings) |

These establish available implementation paths, not successful execution or measured throughput on this M5.
Do not apply CUDA-only flash-attention installation guidance to the Mac.
Pin the chosen packages and backend before evaluation; current stable releases are a snapshot, not a command to upgrade the project.

## Exclusions and optional follow-ups

- **Jina v5:** promising current small models, but CC-BY-NC-4.0 and Python remote-code requirements complicate a generally reusable CLI experiment.
  Its [official MLX port](https://huggingface.co/jinaai/jina-embeddings-v5-text-small-retrieval-mlx) imports downloaded `model.py`; omitting a trust flag does not make that code native.
  The [official nano GGUF](https://huggingface.co/jinaai/jina-embeddings-v5-text-nano-retrieval-GGUF) and [small GGUF](https://huggingface.co/jinaai/jina-embeddings-v5-text-small-retrieval-GGUF) are alternative paths if licensing and runtime validation are resolved.
  V5's [actual implementation](https://huggingface.co/jinaai/jina-embeddings-v5-text-nano/blob/8a7f00aac812071b69403df470f1038ec85f8925/modeling_jina_embeddings_v5.py) uses `task="retrieval"`, `Query: ` / `Document: `, last-token pooling and normalization.
  Do not copy `Passage:` or mean pooling from the v4 optimization article linked by its GGUF cards.
- **EmbeddingGemma-300M:** native implementation exists, but HF requires acceptance of Gemma terms; Gemma 2 is ungated and newer.
  The original uses mean pooling plus learned dense projections, which must survive format conversion; [Google's architecture explanation](https://github.com/google-gemma/docs/blob/main/docs/tutorials/gemma-explained/embeddinggemma.md) documents the complete pipeline.
- **Nomic v2 MoE:** Python `auto_map` references code in another repository; 305M active parameters are not the resident weight count.
  Its [official GGUF collection](https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe-GGUF) includes unquantized formats and could support a subsequent no-Python-custom-code experiment.
  Exact prefixes are `search_query: ` and `search_document: `; masked mean pooling, optional truncation, then normalization.
- **Arctic L v2.0:** valid native-code alternative, omitted from the initial four to bound evaluation work.
  Its query prefix is `query: `, documents are unprefixed, and pooling is CLS followed by normalization.
- **Perplexity V1:** remote code and natively quantized output make it a different first-comparison condition.
  **V2-late:** native modules avoid custom Python, but multi-vector MaxSim requires a different index and scorer; do not pool it into a dense substitute.
- **Qwen 4B:** optional quality ceiling after the first four. BF16 weights alone are approximately 7.5 GiB; full 32K batches also need activation and runtime memory.

## Popularity snapshot

HF `downloads` is trailing-month activity; `likes` is cumulative. Values below were read from the linked official APIs on 2026-10-26.
They indicate ecosystem usage and exposure, **not model quality, unique users, or Chinese→Japanese retrieval accuracy**.
New models have shorter exposure; mirrored or converted repositories split activity across IDs.

| Checkpoint | Downloads | Likes | Metadata source |
| --- | ---: | ---: | --- |
| Qwen3-Embedding-0.6B | 8,188,031 | 1,310 | [HF API](https://huggingface.co/api/models/Qwen/Qwen3-Embedding-0.6B) |
| Qwen3-Embedding-4B | 1,840,188 | 342 | [HF API](https://huggingface.co/api/models/Qwen/Qwen3-Embedding-4B) |
| Jina v5 text nano | 101,446 | 100 | [HF API](https://huggingface.co/api/models/jinaai/jina-embeddings-v5-text-nano) |
| Jina v5 text small | 106,698 | 205 | [HF API](https://huggingface.co/api/models/jinaai/jina-embeddings-v5-text-small) |
| EmbeddingGemma-300M | 2,303,854 | 2,058 | [HF API](https://huggingface.co/api/models/google/embeddinggemma-300m) |
| EmbeddingGemma 2 | 212,769 | 2,915 | [HF API](https://huggingface.co/api/models/google/embeddinggemma-2) |
| Nomic Embed v2 MoE | 949,879 | 512 | [HF API](https://huggingface.co/api/models/nomic-ai/nomic-embed-text-v2-moe) |
| BGE-M3 | 29,659,669 | 3,926 | [HF API](https://huggingface.co/api/models/BAAI/bge-m3) |
| Multilingual E5 small | 9,229,897 | 470 | [HF API](https://huggingface.co/api/models/intfloat/multilingual-e5-small) |
| Arctic Embed L v2.0 | 2,578,773 | 265 | [HF API](https://huggingface.co/api/models/Snowflake/snowflake-arctic-embed-l-v2.0) |
| Perplexity V1 0.6B | 297,846 | 237 | [HF API](https://huggingface.co/api/models/perplexity-ai/pplx-embed-v1-0.6b) |
| Perplexity V2-late 0.6B | 2,193 | 62 | [HF API](https://huggingface.co/api/models/perplexity-ai/pplx-embed-v2-late-0.6b) |

## Evaluation implications

The [official MTEB multilingual v2 benchmark](https://leaderboard.mteb.org/benchmark/MTEB%28Multilingual%2C%20v2%29) includes classification, clustering, retrieval, similarity and other tasks.
Its overall score is not a Chinese-query→Japanese-repository retrieval measurement.
The [MIRACL dataset](https://huggingface.co/datasets/miracl/miracl) organizes queries and relevance judgments by language; its multilingual coverage alone does not establish this language-pair result.
Use independently labeled local relevance judgments, difficult negatives, and separate Chinese/Japanese query results to choose the winner.

Establish an unquantized reference for each model before comparing deployment formats.
Compare the exploratory Qwen MLX 4-bit DWQ run against Qwen's own reference; a direct comparison with unquantized E5 confounds model, runtime and quantization.
Weight quantization, output-vector INT8 quantization, and MRL dimension truncation are separate variables.
Record model revision, artifact hash, tokenizer, prompts, pooling, normalization, dtype, runtime, device, batch size, chunking and truncation.
Avoid `latest`, floating branches and model-name-only cache keys; conversions need their own revisions and provenance.
After downloading public model artifacts, evaluation must remain local and must not send repository content to embedding APIs.
