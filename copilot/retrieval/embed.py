"""Query-side embedding for retrieval.

Mirrors the ingestion embedding (gemini-embedding-001, 768 dims, L2-normalised)
but uses task_type RETRIEVAL_QUERY. The asymmetry is deliberate: using
RETRIEVAL_DOCUMENT on a query silently costs recall.
"""

import math
import os

from google import genai
from google.genai import types

EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 768

_client = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _client


def _l2_normalise(vec: list[float]) -> list[float]:
    """Scale to unit length (Matryoshka truncated prefix is not unit-norm)."""
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0:
        raise ValueError("embedding has zero norm")
    return [x / norm for x in vec]


def embed_query(text: str) -> list[float]:
    """Embed a single query string. Returns 768-dim L2-normalised vector."""
    client = _get_client()
    resp = client.models.embed_content(
        model=EMBED_MODEL,
        contents=[text],
        config=types.EmbedContentConfig(
            task_type="RETRIEVAL_QUERY",
            output_dimensionality=EMBED_DIM,
        ),
    )
    raw = list(resp.embeddings[0].values)
    return _l2_normalise(raw)
