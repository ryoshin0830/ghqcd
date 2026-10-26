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
    # Added after the first comparison (2026-10-26 survey update).
    "harrier-0.6b": dict(repo="microsoft/harrier-oss-v1-0.6b", rev="f9b9dc8d367d443f2479d27aa5d8d2850c0774ee",
                         q="Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: {}", d="{}", dim=1024),
    "harrier-270m": dict(repo="microsoft/harrier-oss-v1-270m", rev="31de22b673913c7d658c0f03f792d77c2dcf8ebd",
                         q="Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: {}", d="{}", dim=640),
    "granite-311m": dict(repo="ibm-granite/granite-embedding-311m-multilingual-r2", rev="44399559930365213510b1ee2eb15ded83374f0e",
                         q="{}", d="{}", dim=768),
    "granite-97m": dict(repo="ibm-granite/granite-embedding-97m-multilingual-r2", rev="835ad14087e140460703cf0fae09f97d469d65c2",
                        q="{}", d="{}", dim=384),
}
# Weights: safetensors only, except bge-m3 which ships no safetensors at this revision
# (loaded through torch's weights_only unpickler; see report).
ALLOW = ["*.json", "*.txt", "*.model", "*.jinja", "1_Pooling/*", "2_Normalize/*"]
WEIGHTS = {"bge-m3": ["pytorch_model.bin"]}
IGNORE = ["onnx/*", "openvino/*", "openvino_model.*", "imgs/*", ".eval_results/*"]
