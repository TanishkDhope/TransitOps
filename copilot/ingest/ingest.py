"""Build the copilot retrieval corpus: files on disk -> rows in Neon.

Ingestion only. Nothing here retrieves, answers or evaluates anything.

Run from the copilot/ directory:

    uv run python -m ingest.ingest --dry-run
    uv run python -m ingest.ingest --reset
    uv run python -m ingest.ingest --only internal

Section splitting lives in loaders.py. This module chunks those sections,
embeds the chunks, writes them, and prints a report designed to catch the
failures that would otherwise show up much later as bad answers.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# Relative, so the module runs both ways: `python -m ingest.ingest` from
# copilot/, and `python -m copilot.ingest.ingest` from the repo root.
from . import loaders
from .loaders import Section, SourceDoc

INGEST_DIR = Path(__file__).resolve().parent
COPILOT_DIR = INGEST_DIR.parent
REPO_ROOT = COPILOT_DIR.parent
SCHEMA_SQL = INGEST_DIR / "schema.sql"
CACHE_DIR = INGEST_DIR / ".cache"
RUN_LOG = INGEST_DIR / "runs.jsonl"

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

load_dotenv(COPILOT_DIR / ".env")

DOC_TYPES = ("statute", "insurance", "internal")


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(
            f"{name} is not set. Add it to {COPILOT_DIR / '.env'} "
            f"(see .env.example); the value is the same one used in server/.env."
        )
    return value


# --------------------------------------------------------------------------
# Tokens and chunking
# --------------------------------------------------------------------------

# The embedding model accepts 2,048 input tokens, so the model limit is not the
# binding constraint here — retrieval quality is. A 400-token window is small
# enough that a match is about one idea and large enough to carry the sentence
# that qualifies it.
TARGET_TOKENS = 400
OVERLAP_RATIO = 0.15
CEILING_TOKENS = 600
OVERLAP_TOKENS = int(TARGET_TOKENS * OVERLAP_RATIO)     # 60

_encoder = None


def encoder():
    """cl100k_base, which approximates Gemini's tokeniser closely enough.

    Gemini's own tokeniser is not available offline. cl100k counts run within a
    few per cent on English legal prose, and the numbers are only used to place
    boundaries, not to respect a hard model limit. If the encoding cannot be
    loaded the run stops: falling back to a character heuristic would silently
    move every boundary in the corpus.
    """
    global _encoder
    if _encoder is None:
        import tiktoken
        try:
            _encoder = tiktoken.get_encoding("cl100k_base")
        except Exception as exc:                        # noqa: BLE001
            raise SystemExit(
                f"could not load the cl100k_base tokeniser ({exc}). tiktoken downloads it on "
                f"first use; set TIKTOKEN_CACHE_DIR or run once with network access."
            )
    return _encoder


def ntokens(text: str) -> int:
    return len(encoder().encode(text, disallowed_special=()))


BLANK_LINE = re.compile(r"\n\s*\n")
# PDF text has no blank lines between paragraphs, so a sub-clause marker at the
# start of a line is the next best paragraph boundary for statutes and policies.
CLAUSE_LINE = re.compile(r"(?m)^(?=\s*(?:\(\w{1,4}\)|\d+[A-Z]?\.\s|[ivxlc]+\)))")
SENTENCE = re.compile(r"(?<=[.;:])\s+(?=[A-Z(“\"])")


def _by_blank_lines(text: str) -> list[str]:
    return [p for p in BLANK_LINE.split(text) if p.strip()]


def _by_clause_lines(text: str) -> list[str]:
    return [p for p in CLAUSE_LINE.split(text) if p.strip()]


def _by_sentences(text: str) -> list[str]:
    return [p for p in SENTENCE.split(text) if p.strip()]


def _by_token_windows(text: str) -> list[str]:
    ids = encoder().encode(text, disallowed_special=())
    return [encoder().decode(ids[i:i + CEILING_TOKENS])
            for i in range(0, len(ids), CEILING_TOKENS)]


def _explode(units: list[str], splitter, limit: int = CEILING_TOKENS) -> list[str]:
    """Re-split only the units that are still over the limit."""
    out: list[str] = []
    for unit in units:
        if ntokens(unit) <= limit:
            out.append(unit)
            continue
        parts = splitter(unit)
        out.extend(parts if len(parts) > 1 else [unit])
    return out


def _pack(units: list[str]) -> list[str]:
    """Greedily fill chunks to the target, carrying an overlap tail forward."""
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for unit in units:
        cost = ntokens(unit)
        if current and size + cost > TARGET_TOKENS:
            chunks.append("\n".join(current))
            # Overlap keeps a sentence that qualifies the next one from being
            # orphaned on the far side of a boundary.
            tail: list[str] = []
            tail_size = 0
            for prev in reversed(current):
                prev_size = ntokens(prev)
                if tail_size + prev_size > OVERLAP_TOKENS:
                    break
                tail.insert(0, prev)
                tail_size += prev_size
            if tail_size + cost > CEILING_TOKENS:
                tail, tail_size = [], 0
            current, size = tail, tail_size
        current.append(unit)
        size += cost
    if current:
        chunks.append("\n".join(current))
    return chunks


def chunk_section(section: Section) -> list[str]:
    text = section.content.strip()
    if not text:
        return []
    # A table or an IMT endorsement is one unit of meaning. Half a table is a
    # grid of numbers with no header; half an endorsement is a contractual
    # clause missing the words that qualify it.
    if section.atomic:
        return [text]
    if ntokens(text) <= CEILING_TOKENS:
        return [text]
    units = _by_blank_lines(text)
    units = _explode(units, _by_clause_lines)
    units = _explode(units, _by_sentences)
    units = _explode(units, _by_token_windows)
    return _pack(units)


def breadcrumb(doc_title: str, section_path: str, body: str) -> str:
    """The exact string that is stored, embedded and keyword-indexed.

    It is built once, here, and the single return value is used for all three.
    `chunks.tsv` is a generated column over `chunks.content`, so as long as the
    string handed to the embedder is the string written to the column, the
    vector index and the keyword index cover identical text. If the two ever
    diverge, nothing errors: a later rank fusion would just be combining two
    rankings computed over two different corpora, and would quietly return
    worse results than either index alone.
    """
    return f"[{doc_title} > {section_path}]\n\n{body}"


def content_sha_py(content: str) -> str:
    """Mirror of the `chunks.content_sha` generated column in schema.sql.

    Must be kept in step with the SQL expression
    md5(lower(regexp_replace(content, '\\s+', ' ', 'g'))); the dry run uses this
    to report duplicates without a database.
    """
    return hashlib.md5(re.sub(r"\s+", " ", content).lower().encode("utf-8")).hexdigest()


def _pack_hard(units: list[str], limit: int) -> list[str]:
    """Fill pieces up to the limit with no overlap. Used only by the cap guard."""
    pieces: list[str] = []
    current: list[str] = []
    size = 0
    for unit in units:
        cost = ntokens(unit)
        if current and size + cost > limit:
            pieces.append("\n".join(current))
            current, size = [], 0
        current.append(unit)
        size += cost
    if current:
        pieces.append("\n".join(current))
    return pieces


def enforce_input_cap(built):
    """Split any chunk that exceeds the embedding model's input cap.

    A chunk over the cap is either rejected by the API or silently truncated,
    and a truncated one is worse: the row would hold text that its own embedding
    does not describe, which reads later as unexplained bad retrieval rather
    than as an error. So oversize chunks are split into consecutive chunks of
    the same section, each carrying the same breadcrumb, and every split is
    logged and counted.

    The split happens after chunking, on the stored string, so the invariant in
    breadcrumb() still holds: what gets embedded is what gets written.
    """
    events = []
    for doc, rows in built:
        for index, (section, chunks) in enumerate(rows):
            rebuilt: list[str] = []
            for content in chunks:
                size = ntokens(content)
                if size <= EMBED_SPLIT_THRESHOLD:
                    rebuilt.append(content)
                    continue
                prefix = breadcrumb(doc.title, section.section_path, "")
                body = content[len(prefix):]
                budget = EMBED_SPLIT_THRESHOLD - ntokens(prefix)
                units = _by_blank_lines(body) or [body]
                units = _explode(units, _by_clause_lines, budget)
                units = _explode(units, _by_sentences, budget)
                units = _explode(units, lambda t, b=budget: _windows(t, b), budget)
                pieces = [breadcrumb(doc.title, section.section_path, p)
                          for p in _pack_hard(units, budget)]
                events.append({
                    "document": doc.title,
                    "section_path": section.section_path,
                    "original_tokens": size,
                    "pieces": [ntokens(p) for p in pieces],
                })
                print(f"  over input cap: {size} tokens -> {len(pieces)} pieces "
                      f"{[ntokens(p) for p in pieces]}\n"
                      f"      {doc.title} — {section.section_path[:90]}", flush=True)
                rebuilt.extend(pieces)
            rows[index] = (section, rebuilt)
    return events


def _windows(text: str, limit: int) -> list[str]:
    ids = encoder().encode(text, disallowed_special=())
    return [encoder().decode(ids[i:i + limit]) for i in range(0, len(ids), limit)]


# --------------------------------------------------------------------------
# Embeddings
# --------------------------------------------------------------------------

EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 768
EMBED_BATCH = 64
# The project is on Gemini Tier 1 — 3,000 requests and 1,000,000 tokens per
# minute, no daily cap. This corpus is ~1,360 chunks, so about 22 requests and a
# few hundred thousand tokens: nowhere near either limit. There is deliberately
# no pacing, no token bucket and no scheduler here. Backoff below handles a 429
# if one ever appears, and pacing can be added then, informed by the actual
# error rather than guessed at now.
MAX_ATTEMPTS = 5

# gemini-embedding-001 accepts at most 2,048 input tokens. Chunks are capped at
# 600 by the chunker, except atomic ones (tables, endorsements) which are emitted
# whole at whatever size they are — and the CMVR annexure tables reach 2,264.
# The guard sits here rather than in the splitter because it is a property of the
# model, not of the document: change the model and this moves, the splitter does
# not. 2,000 leaves margin for the difference between cl100k and Gemini's own
# tokeniser.
EMBED_MAX_TOKENS = 2_048
EMBED_SPLIT_THRESHOLD = 2_000

# Not every 429 is a rate limit. A spending cap or a disabled key returns the
# same status, and no amount of backoff will clear it — retrying just turns one
# wasted request into MAX_ATTEMPTS per batch. Seen in practice: the project's
# monthly spend cap, which failed all 21 batches identically and cost 105
# requests before this check existed.
TERMINAL_429 = re.compile(
    r"spending cap|spend cap|billing|suspended|disabled|API key not valid", re.I)
# If several batches in a row fail outright, the fault is the account or the
# network, not this batch. Stop rather than working through the whole corpus.
CONSECUTIVE_FAILURE_LIMIT = 3


def l2_normalise(vec: list[float]) -> list[float]:
    """Scale a vector to unit length.

    gemini-embedding-001 uses Matryoshka representation learning: the full
    3072-dimension output is unit length, but a truncated prefix of it — which
    is what output_dimensionality=768 returns — is not. Cosine distance assumes
    unit vectors, so without this step every distance in the index would be
    subtly wrong, in a way that still returns plausible-looking results.
    """
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0:
        raise ValueError("embedding has zero norm")
    return [x / norm for x in vec]


class Embedder:
    """Batched Gemini embeddings with a local checkpoint.

    The checkpoint is a JSONL file keyed by content_sha — the same normalised
    hash the database generates for `chunks.content` — so a mid-run failure
    resumes instead of re-embedding, and a re-run after a splitter change only
    pays for chunks whose text actually moved. Entries are appended as each
    batch lands, so an interrupted run keeps everything it had already bought.
    """

    def __init__(self, api_key: str, use_cache: bool = True):
        from google import genai
        from google.genai import types

        self._types = types
        self.client = genai.Client(api_key=api_key)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self.cache_path = CACHE_DIR / "embeddings.jsonl"
        self.cache: dict[str, list[float]] = {}
        if use_cache:
            self.cache = self._load_cache()
        self.hits = 0
        self.misses = 0
        self.requests = 0
        self.tokens = 0
        self.failures: list[dict] = []
        self.vectors: dict[str, list[float]] = {}

    def _load_cache(self) -> dict[str, list[float]]:
        if not self.cache_path.exists():
            return {}
        cache: dict[str, list[float]] = {}
        bad = 0
        with self.cache_path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                    if row.get("model") == EMBED_MODEL and row.get("dim") == EMBED_DIM:
                        cache[row["sha"]] = row["vec"]
                except (ValueError, KeyError):
                    # A run killed mid-write can leave one truncated line. Skip
                    # it rather than refusing to start.
                    bad += 1
        if bad:
            print(f"  checkpoint: skipped {bad} unreadable line(s)")
        return cache

    def _append_cache(self, rows: list[tuple[str, list[float]]]) -> None:
        with self.cache_path.open("a", encoding="utf-8") as fh:
            for sha, vec in rows:
                # 7 decimals is finer than the float4 precision pgvector stores,
                # and keeps the file about a third the size of full repr.
                fh.write(json.dumps({"sha": sha, "model": EMBED_MODEL, "dim": EMBED_DIM,
                                     "vec": [round(x, 7) for x in vec]}) + "\n")

    @staticmethod
    def _status(exc) -> int | None:
        code = getattr(exc, "code", None)
        if isinstance(code, int):
            return code
        response = getattr(exc, "response", None)
        code = getattr(response, "status_code", None)
        if isinstance(code, int):
            return code
        match = re.match(r"\s*(\d{3})\b", str(exc))
        return int(match.group(1)) if match else None

    @staticmethod
    def _origin(batch: list[str]) -> str:
        """The '[Title > section path]' line of the first chunk in a batch."""
        first = batch[0].split("\n", 1)[0]
        return first[:110]

    def _send(self, batch: list[str]) -> list[list[float]]:
        self.requests += 1
        resp = self.client.models.embed_content(
            model=EMBED_MODEL,
            contents=batch,
            config=self._types.EmbedContentConfig(
                task_type="RETRIEVAL_DOCUMENT",
                output_dimensionality=EMBED_DIM,
            ),
        )
        return [list(e.values) for e in resp.embeddings]

    def _keep(self, batch: list[str], raw: list[list[float]]) -> None:
        rows = []
        for text, vec in zip(batch, raw):
            if len(vec) != EMBED_DIM:
                raise SystemExit(f"expected {EMBED_DIM} dimensions, got {len(vec)}")
            unit = l2_normalise(vec)
            self.vectors[text] = unit
            rows.append((content_sha_py(text), unit))
        self._append_cache(rows)

    def _fail(self, index: int, batch: list[str], tokens: int, status, exc) -> None:
        self.failures.append({
            "batch": index,
            "status": status,
            "chunks": len(batch),
            "tokens": tokens,
            "origin": self._origin(batch),
            "error": str(exc)[:300],
        })

    def _process(self, index: int, batch: list[str], halved: bool = False) -> None:
        """Embed one batch. Never raises — a bad batch is recorded and skipped.

        One batch failing must not cost the whole run: the other twenty-odd
        requests are already paid for, and the report lists what was missed.
        """
        tokens = sum(ntokens(t) for t in batch)
        for attempt in range(MAX_ATTEMPTS):
            try:
                self._keep(batch, self._send(batch))
                self.tokens += tokens
                return
            except Exception as exc:                    # noqa: BLE001
                status = self._status(exc)
                if status == 429:
                    kind = "rate limited"
                elif status == 400:
                    kind = "bad request (likely an oversize input)"
                elif status is not None and 500 <= status < 600:
                    kind = "transient server error"
                else:
                    kind = "transport or unknown error"
                if status == 429 and TERMINAL_429.search(str(exc)):
                    kind = "account limit, not throughput — retrying cannot help"
                    print(f"    batch {index}: HTTP {status} — {kind}\n"
                          f"      {str(exc)[:260]}", flush=True)
                    self._fail(index, batch, tokens, status, exc)
                    raise SystemExit(
                        "\nStopping: the embedding API rejected the request for an account "
                        "reason, not a rate limit.\n"
                        f"  {str(exc)[:300]}\n"
                        "Backoff cannot clear this. Fix the account condition and re-run; "
                        "chunks already embedded are checkpointed and will not be paid for "
                        "again."
                    )

                print(f"    batch {index}: HTTP {status} — {kind}; "
                      f"{len(batch)} chunks, {tokens} tokens\n"
                      f"      first: {self._origin(batch)}\n"
                      f"      {str(exc)[:220]}", flush=True)

                if status == 400:
                    # Halve once and retry: if a single chunk is the problem,
                    # this isolates it and the rest of the batch still lands.
                    if len(batch) > 1 and not halved:
                        mid = len(batch) // 2
                        print(f"    batch {index}: halving and retrying "
                              f"({mid} + {len(batch) - mid})", flush=True)
                        self._process(index, batch[:mid], halved=True)
                        self._process(index, batch[mid:], halved=True)
                        return
                    self._fail(index, batch, tokens, status, exc)
                    return

                if attempt == MAX_ATTEMPTS - 1:
                    self._fail(index, batch, tokens, status, exc)
                    return
                delay = 2 ** attempt + random.random()
                print(f"    batch {index}: retrying in {delay:.1f}s "
                      f"(attempt {attempt + 2}/{MAX_ATTEMPTS})", flush=True)
                time.sleep(delay)

    def embed(self, texts: list[str]) -> dict[str, list[float]]:
        """Map each distinct text to its unit vector.

        Texts whose batch failed are absent from the result; the caller skips
        those chunks and the report names them.
        """
        unique = list(dict.fromkeys(texts))
        todo: list[str] = []
        for text in unique:
            cached = self.cache.get(content_sha_py(text))
            if cached is None:
                todo.append(text)
                self.misses += 1
            else:
                self.vectors[text] = cached
                self.hits += 1
        print(f"  {self.hits} cached, {self.misses} to embed")
        batches = [todo[i:i + EMBED_BATCH] for i in range(0, len(todo), EMBED_BATCH)]
        consecutive = 0
        for index, batch in enumerate(batches):
            before = len(self.failures)
            self._process(index, batch)
            consecutive = 0 if len(self.failures) == before else consecutive + 1
            if consecutive >= CONSECUTIVE_FAILURE_LIMIT:
                print(f"    stopping: {consecutive} batches failed in a row; "
                      f"{len(batches) - index - 1} batch(es) not attempted", flush=True)
                break
            print(f"    batch {index + 1}/{len(batches)} done "
                  f"({len(self.vectors)}/{len(unique)} vectors)", flush=True)
        return self.vectors


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------

SEARCH_INDEXES = ("chunks_embedding_hnsw", "chunks_tsv_gin",
                  "chunks_content_sha_idx", "chunks_bm25")


def schema_sections() -> dict[str, str]:
    """Split schema.sql on its `-- @section:` markers."""
    parts: dict[str, str] = {}
    name = None
    buf: list[str] = []
    for line in SCHEMA_SQL.read_text(encoding="utf-8").split("\n"):
        marker = re.match(r"^--\s*@section:\s*(\w+)\s*$", line)
        if marker:
            if name:
                parts[name] = "\n".join(buf)
            name, buf = marker.group(1), []
            continue
        buf.append(line)
    if name:
        parts[name] = "\n".join(buf)
    return parts


def bm25_available(cur) -> str | None:
    cur.execute("SELECT extname FROM pg_extension WHERE extname IN ('pg_textsearch','pg_search')")
    row = cur.fetchone()
    return row[0] if row else None


def vector_literal(vec: list[float]) -> str:
    # pgvector parses this text form server-side, so no client-side adapter is
    # needed and COPY stays a plain text stream.
    return "[" + ",".join(f"{x:.7g}" for x in vec) + "]"


def write_document(cur, doc: SourceDoc, rows, vectors) -> tuple[int, int]:
    """Replace one document and everything under it. Returns (sections, chunks).

    Delete-then-insert, never UPDATE. An UPDATE of an embedding does not
    overwrite the old row; Postgres writes a new version and leaves the old one
    as a dead tuple until vacuum reclaims it. Re-embedding the same corpus in
    place a dozen times while tuning is the realistic way to fill a small
    instance with rows nobody can read.
    """
    cur.execute("DELETE FROM copilot.documents WHERE source_path = %s", (doc.source_path,))
    cur.execute(
        """INSERT INTO copilot.documents
               (title, doc_type, issuer, source_path, source_format, page_count)
           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
        (doc.title, doc.doc_type, doc.issuer, doc.source_path,
         doc.source_format, doc.page_count),
    )
    document_id = cur.fetchone()[0]

    sections = [s for s, _ in rows]
    cur.execute(
        """INSERT INTO copilot.sections
               (document_id, section_path, ordinal, content, page_from, page_to)
           SELECT %s, s.path, s.ord, s.body, s.pf, s.pt
             FROM unnest(%s::text[], %s::int[], %s::text[], %s::int[], %s::int[])
                  AS s(path, ord, body, pf, pt)
        RETURNING id, ordinal""",
        (document_id,
         [s.section_path for s in sections],
         list(range(len(sections))),
         [s.content for s in sections],
         [s.page_from for s in sections],
         [s.page_to for s in sections]),
    )
    section_ids = {ordinal: sid for sid, ordinal in cur.fetchall()}

    n_chunks = 0
    skipped = 0
    with cur.copy("COPY copilot.chunks (section_id, ordinal, content, embedding) "
                  "FROM STDIN") as copy:
        for ordinal, (_, chunks) in enumerate(rows):
            position = 0
            for content in chunks:
                vector = vectors.get(content)
                if vector is None:
                    # Its batch failed. embedding is NOT NULL, so the row cannot
                    # be written; the report lists the failed batches. Ordinals
                    # stay consecutive over what was actually stored.
                    skipped += 1
                    continue
                copy.write_row((section_ids[ordinal], position, content,
                                vector_literal(vector)))
                position += 1
                n_chunks += 1
    return len(sections), n_chunks, skipped


def verify(cur) -> list[str]:
    """Check the database, not the in-memory model.

    Everything above this line believes what the script thinks it wrote. These
    queries ask Postgres what is actually there.
    """
    out: list[str] = []

    cur.execute("SELECT (SELECT count(*) FROM copilot.documents), "
                "(SELECT count(*) FROM copilot.sections), "
                "(SELECT count(*) FROM copilot.chunks)")
    documents, sections, chunks = cur.fetchone()
    out.append(f"row counts        documents {documents}  sections {sections}  chunks {chunks}")

    cur.execute("SELECT count(*) FROM copilot.chunks WHERE embedding IS NULL")
    nulls = cur.fetchone()[0]
    out.append(f"null embeddings   {nulls}" + ("" if nulls == 0 else "   <-- PROBLEM"))

    # L2 norm, measured as the distance from the origin. Anything not ~1.0 means
    # the renormalisation after truncating to 768 dimensions was skipped, and
    # every cosine distance in the index is subtly wrong.
    zero = "[" + ",".join("0" for _ in range(EMBED_DIM)) + "]"
    cur.execute("SELECT min(n), max(n) FROM (SELECT l2_distance(embedding, %s::vector) AS n "
                "FROM copilot.chunks ORDER BY random() LIMIT 20) s", (zero,))
    low, high = cur.fetchone()
    if low is None:
        out.append("vector norms      no rows to sample")
    else:
        ok = abs(low - 1.0) < 1e-3 and abs(high - 1.0) < 1e-3
        out.append(f"vector norms      sample of 20: min {low:.6f}  max {high:.6f}   "
                   + ("within 1e-3 of 1.0" if ok else "<-- NOT UNIT LENGTH"))

    cur.execute("SELECT embedding FROM copilot.chunks LIMIT 1")
    row = cur.fetchone()
    if row:
        probe = row[0] if isinstance(row[0], str) else str(row[0])
        query = ("SELECT id FROM copilot.chunks ORDER BY embedding <=> %s::vector LIMIT 5")
        cur.execute("EXPLAIN (ANALYZE, COSTS OFF) " + query, (probe,))
        plan = "\n".join(r[0] for r in cur.fetchall())
        scan = next((ln.strip() for ln in plan.split("\n")
                     if "Scan" in ln), "(no scan node)")
        out.append(f"knn plan          {scan}")
        if "Seq Scan" in scan:
            # At ~1,400 rows a sequential scan can genuinely be cheaper, so this
            # is not proof the index is broken. Force it off to prove it works.
            cur.execute("SET LOCAL enable_seqscan = off")
            cur.execute("EXPLAIN (ANALYZE, COSTS OFF) " + query, (probe,))
            forced = "\n".join(r[0] for r in cur.fetchall())
            node = next((ln.strip() for ln in forced.split("\n") if "Scan" in ln), "?")
            cur.execute("SET LOCAL enable_seqscan = on")
            out.append(f"                  with seqscan off: {node}")

    cur.execute("SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) "
                "FROM pg_stat_user_indexes WHERE schemaname = 'copilot' ORDER BY 1")
    for name, size in cur.fetchall():
        out.append(f"index             {name:<26} {size}")

    extension = bm25_available(cur)
    if extension:
        out.append(f"keyword search    BM25 index via {extension}")
    else:
        cur.execute("SELECT count(*) FROM pg_available_extensions "
                    "WHERE name IN ('pg_textsearch','pg_search')")
        available = cur.fetchone()[0]
        out.append("keyword search    tsvector + GIN, ranked with ts_rank_cd "
                   "(cover density, NOT BM25)")
        out.append(f"                  pg_textsearch/pg_search installed: no; "
                   f"offered by this server: {'yes' if available else 'no'}")

    for table in ("documents", "sections", "chunks"):
        cur.execute("SELECT pg_size_pretty(pg_total_relation_size(%s)), "
                    "pg_size_pretty(pg_table_size(%s))", (f"copilot.{table}",) * 2)
        total, heap = cur.fetchone()
        out.append(f"size              copilot.{table:<10} total {total:>9}   heap {heap:>9}")
    cur.execute("SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) FROM pg_class c "
                "JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = 'copilot' AND c.relkind = 'r'")
    out.append(f"size              copilot schema total {cur.fetchone()[0]}")
    return out


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------


def percentile(values: list[int], p: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round((len(ordered) - 1) * p)))
    return ordered[idx]


def print_report(built, keyword_path: str, dry_run: bool, embedder=None, db_totals=None,
                 splits=None, elapsed=None, checks=None, skipped=0):
    """Every number here exists because it catches one specific failure."""
    print("\n" + "=" * 72)
    print("INGESTION REPORT" + ("  (dry run — nothing was embedded or written)" if dry_run else ""))
    print("=" * 72)

    n_sections = sum(len(rows) for _, rows in built)
    all_chunks = [(doc, sec, content)
                  for doc, rows in built for sec, chunks in rows for content in chunks]
    print(f"\ndocuments {len(built)}   sections {n_sections}   chunks {len(all_chunks)}")

    tokens = [ntokens(c) for _, _, c in all_chunks]
    if tokens:
        print("\ntokens per chunk (stored text, breadcrumb included)")
        print(f"  min {min(tokens)}   median {int(statistics.median(tokens))}   "
              f"p95 {percentile(tokens, 0.95)}   max {max(tokens)}")
        print(f"  target {TARGET_TOKENS}, ceiling {CEILING_TOKENS}, "
              f"overlap {OVERLAP_TOKENS} (cl100k_base)")
        over = [(d.title, s.section_path, t) for (d, s, _), t in zip(all_chunks, tokens)
                if t > CEILING_TOKENS]
        print(f"  above the ceiling: {len(over)} (expected: tables and IMT endorsements)")
        for title, path, t in sorted(over, key=lambda r: -r[2])[:5]:
            print(f"    {t:6d}  {title} — {path[:70]}")

    empty = [(doc.title, sec.section_path) for doc, rows in built
             for sec, chunks in rows if not chunks]
    print(f"\nsections with zero chunks: {len(empty)}")
    for title, path in empty[:10]:
        print(f"  {title} — {path[:80]}")

    blank = [(d.title, s.section_path) for d, s, c in all_chunks
             if not re.search(r"[0-9A-Za-z]", c.split("\n\n", 1)[-1])]
    print(f"chunks with no alphanumeric body: {len(blank)}")
    for title, path in blank[:10]:
        print(f"  {title} — {path[:80]}")

    # Two hashes, because they answer different questions. content_sha is the
    # generated column: it hashes the stored text, breadcrumb included, and is
    # what a query-time dedupe would use. The breadcrumb starts with the
    # document title, so the same paragraph appearing in two documents can
    # never collide on it. The body hash ignores the breadcrumb and is what
    # actually finds text duplicated across documents.
    stored: dict[str, list[tuple[str, str]]] = {}
    bodies: dict[str, list[tuple[str, str]]] = {}
    for doc, sec, content in all_chunks:
        stored.setdefault(content_sha_py(content), []).append((doc.title, sec.section_path))
        body = content.split("\n\n", 1)[-1]
        bodies.setdefault(content_sha_py(body), []).append((doc.title, sec.section_path))
    dupes = {k: v for k, v in stored.items() if len(v) > 1}
    cross = {k: v for k, v in bodies.items() if len({t for t, _ in v}) > 1}
    print(f"\nduplicate content_sha groups (stored text): {len(dupes)}")
    for sha, rows in sorted(dupes.items(), key=lambda kv: -len(kv[1]))[:5]:
        print(f"  {sha[:10]}  x{len(rows)}  {rows[0][0]}")
        print(f"              {rows[0][1][:74]}")
    print(f"identical chunk bodies across documents: {len(cross)} group(s)")
    for sha, rows in sorted(cross.items(), key=lambda kv: -len(kv[1]))[:8]:
        titles = ", ".join(sorted({t for t, _ in rows}))
        print(f"  {sha[:10]}  x{len(rows)}  {titles}")
        print(f"              {rows[0][1][:74]}")

    by_type: dict[str, int] = {}
    by_format: dict[str, int] = {}
    for doc, rows in built:
        n = sum(len(c) for _, c in rows)
        by_type[doc.doc_type] = by_type.get(doc.doc_type, 0) + n
        by_format[doc.source_format] = by_format.get(doc.source_format, 0) + n
    print("\nchunks by doc_type:    " + "  ".join(f"{k}={v}" for k, v in sorted(by_type.items())))
    print("chunks by source_format: " + "  ".join(f"{k}={v}" for k, v in sorted(by_format.items())))

    missing = [d.title for d, _ in built if not d.issuer]
    print(f"\ndocuments with no issuer: {len(missing)}"
          + ("  -> " + ", ".join(missing) if missing else ""))

    print("\nper document:")
    for doc, rows in built:
        n = sum(len(c) for _, c in rows)
        pages = f"{doc.page_count}p" if doc.page_count else "—"
        print(f"  {doc.title[:46]:<46} {doc.doc_type:<10} {pages:>5}  "
              f"{len(rows):>4} sections  {n:>5} chunks")
        for note in doc.notes:
            print(f"      note: {note}")

    print(f"\nchunks hard-split for exceeding the {EMBED_MAX_TOKENS}-token input cap: "
          f"{len(splits or [])}")
    for event in (splits or []):
        print(f"  {event['original_tokens']} tokens -> {event['pieces']}")
        print(f"      {event['document']} — {event['section_path'][:80]}")

    if embedder is not None:
        print(f"\nembedding")
        print(f"  model {EMBED_MODEL}, {EMBED_DIM} dims, task_type RETRIEVAL_DOCUMENT, "
              f"L2-normalised")
        print(f"  cache: {embedder.hits} hit(s), {embedder.misses} miss(es)")
        print(f"  {embedder.requests} API request(s), {embedder.tokens} tokens embedded")
        print(f"\nfailed batches: {len(embedder.failures)}")
        for failure in embedder.failures:
            print(f"  batch {failure['batch']}  HTTP {failure['status']}  "
                  f"{failure['chunks']} chunks  {failure['tokens']} tokens")
            print(f"      first: {failure['origin']}")
            print(f"      {failure['error'][:160]}")
        if skipped:
            print(f"  {skipped} chunk(s) not written because their batch failed")

    if checks:
        print("\ndatabase verification (queried, not inferred):")
        for line in checks:
            print("  " + line)

    print(f"\nkeyword search: {keyword_path}")
    if db_totals:
        print(f"database totals: documents {db_totals[0]}  sections {db_totals[1]}  "
              f"chunks {db_totals[2]}")
    if elapsed is not None:
        print(f"wall clock: {elapsed:.0f}s")
    print("=" * 72 + "\n")


# --------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------


def build(only: str | None):
    """Load, chunk and breadcrumb everything, without embedding or writing.

    The strings this returns are the final stored `chunks.content` values, so
    the report measures exactly what the database will hold and the embedder
    is handed exactly what is written.
    """
    built = []
    for path in loaders.discover(REPO_ROOT):
        # Decide from the filename before opening the file: parsing the 489-page
        # CMVR takes most of a --dry-run, and --only exists to avoid it.
        if only and loaders.doc_type_of(path) != only:
            continue
        doc = loaders.load(path, REPO_ROOT)
        if doc is None:
            print(f"  skipped (unrecognised): {path.name}")
            continue
        rows = [(sec, [breadcrumb(doc.title, sec.section_path, body)
                       for body in chunk_section(sec)])
                for sec in doc.sections]
        print(f"  {doc.source_path}: {len(rows)} sections, "
              f"{sum(len(c) for _, c in rows)} chunks")
        built.append((doc, rows))
    return built


def log_run(args, keyword_path: str, built, elapsed: float, embedder=None,
            splits=None, checks=None):
    """One line per run, so a later result can be traced to what produced it."""
    RUN_LOG.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "flags": {"reset": args.reset, "only": args.only, "dry_run": args.dry_run},
        "chunker": {"target_tokens": TARGET_TOKENS, "ceiling_tokens": CEILING_TOKENS,
                    "overlap_tokens": OVERLAP_TOKENS, "tokeniser": "cl100k_base"},
        "embedding": {"model": EMBED_MODEL, "dimensions": EMBED_DIM,
                      "task_type": "RETRIEVAL_DOCUMENT", "normalised": "l2",
                      "api_requests": (embedder.requests if embedder else 0),
                      "tokens": (embedder.tokens if embedder else 0),
                      "cache_hits": (embedder.hits if embedder else 0),
                      "cache_misses": (embedder.misses if embedder else 0),
                      "failed_batches": ([f["batch"] for f in embedder.failures]
                                         if embedder else [])},
        "input_cap_splits": splits or [],
        "verification": checks or [],
        "indexes": keyword_path,
        "counts": {"documents": len(built),
                   "sections": sum(len(r) for _, r in built),
                   "chunks": sum(len(c) for _, rows in built for _, c in rows)},
        "elapsed_seconds": round(elapsed, 1),
    }
    with RUN_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="ingest", description="Build the copilot retrieval corpus.")
    parser.add_argument("--reset", action="store_true",
                        help="truncate all three tables before loading")
    parser.add_argument("--only", choices=DOC_TYPES,
                        help="ingest a single doc_type")
    parser.add_argument("--dry-run", action="store_true",
                        help="chunk and report only: no embedding calls, no database")
    parser.add_argument("--no-cache", action="store_true",
                        help="ignore the local checkpoint and re-embed every chunk")
    args = parser.parse_args()

    started = time.time()
    print("loading and chunking:")
    built = build(args.only)
    if not built:
        raise SystemExit("nothing to ingest")

    print("\nchecking the embedding input cap:")
    splits = enforce_input_cap(built)
    print(f"  {len(splits)} chunk(s) split to fit under {EMBED_MAX_TOKENS} tokens")

    if args.dry_run:
        print_report(built, "not checked (dry run)", dry_run=True, splits=splits,
                     elapsed=time.time() - started)
        log_run(args, "not checked", built, time.time() - started, splits=splits)
        return 0

    import psycopg

    database_url = require_env("DATABASE_URL")
    api_key = require_env("GEMINI_API_KEY")
    embedder = Embedder(api_key, use_cache=not args.no_cache)
    parts = schema_sections()

    # The strings embedded here are the same strings written to chunks.content
    # below and, through the generated tsv column, the same strings the keyword
    # index covers. There is no second place where a chunk's text is built.
    texts = [content for _, rows in built for _, chunks in rows for content in chunks]
    print(f"\nembedding {len(texts)} chunks ({len(set(texts))} distinct):")
    # embed() already returns {text: vector}, keyed by the stored string.
    vectors = embedder.embed(texts)

    print("\nwriting:")
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(parts["base"])
            extension = bm25_available(cur)
            if extension:
                keyword_path = f"BM25 ranking available via {extension}"
            else:
                keyword_path = ("tsvector/GIN with ts_rank_cd (cover-density ranking, "
                                "not BM25) — pg_textsearch is not installed")
            print(f"  keyword search: {keyword_path}")

            if args.reset:
                # TRUNCATE rather than DELETE: it reclaims the space immediately
                # instead of leaving every old row behind as a dead tuple.
                cur.execute("TRUNCATE copilot.chunks, copilot.sections, copilot.documents "
                            "RESTART IDENTITY CASCADE")
                print("  truncated all three tables")

            # Always before the load. Maintaining an HNSW graph row by row is far
            # slower than building it once over the finished table.
            for index in SEARCH_INDEXES:
                cur.execute(f"DROP INDEX IF EXISTS copilot.{index}")
            print("  dropped search indexes")

            skipped = 0
            for doc, rows in built:
                n_sections, n_chunks, missed = write_document(cur, doc, rows, vectors)
                skipped += missed
                print(f"  {doc.source_path}: {n_sections} sections, {n_chunks} chunks"
                      + (f"  ({missed} skipped, no embedding)" if missed else ""))

            cur.execute(parts["indexes"])
            print("  rebuilt hnsw + gin + content_sha indexes")
            if extension:
                cur.execute(parts["bm25"])
                print("  created the bm25 index")
            cur.execute("ANALYZE copilot.chunks")

            cur.execute("SELECT (SELECT count(*) FROM copilot.documents), "
                        "(SELECT count(*) FROM copilot.sections), "
                        "(SELECT count(*) FROM copilot.chunks)")
            totals = cur.fetchone()
            print("\nverifying against the database:")
            checks = verify(cur)
        conn.commit()

    elapsed = time.time() - started
    print_report(built, keyword_path, dry_run=False, embedder=embedder, db_totals=totals,
                 splits=splits, elapsed=elapsed, checks=checks, skipped=skipped)
    log_run(args, keyword_path, built, elapsed, embedder, splits=splits, checks=checks)
    print(f"done in {elapsed:.0f}s; run logged to {RUN_LOG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
