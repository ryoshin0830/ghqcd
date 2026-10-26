# Pinned model profiles. Templates follow each model's official ST config / model card.
MODELS = {
    "e5-small": dict(repo="intfloat/multilingual-e5-small", rev="614241f622f53c4eeff9890bdc4f31cfecc418b3",
                     q="query: {}", d="passage: {}", dim=384),
    "qwen3-0.6b": dict(repo="Qwen/Qwen3-Embedding-0.6B", rev="97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
                       q="Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:{}", d="{}", dim=1024),
    "gemma2": dict(repo="google/embeddinggemma-2", rev="914f7f89142e33e77833254d9c9b90c3cef7303b",
                   q="task: search result | query: {}", d="title: none | text: {}", dim=768),
    "bge-m3": dict(repo="BAAI/bge-m3", rev="5617a9f61b028005a4858fdac845db406aefb181",
                   q="{}", d="{}", dim=1024),
}
# Weights: safetensors only, except bge-m3 which ships no safetensors at this revision
# (loaded through torch's weights_only unpickler; see report).
ALLOW = ["*.json", "*.txt", "*.model", "*.jinja", "1_Pooling/*", "2_Normalize/*"]
WEIGHTS = {"bge-m3": ["pytorch_model.bin"]}
IGNORE = ["onnx/*", "openvino/*", "imgs/*", ".eval_results/*"]
