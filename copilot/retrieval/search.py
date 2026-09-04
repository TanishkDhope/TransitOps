"""Hybrid retrieval function and CLI."""

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import psycopg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from copilot.retrieval.embed import embed_query


@dataclass
class RankBreakdown:
    vector_rank: int | None
    fts_rank: int | None
    rrf_score: float


@dataclass
class Retrieved:
    chunk_id: int
    section_id: int
    document_title: str
    issuer: str | None
    section_path: str
    source_url: str
    content: str
    score: float
    vector_dist: float | None
    ranks: RankBreakdown


def _build_sql(mode: str) -> tuple[str, bool, bool, bool]:
    """Return the SQL query and flags for which CTEs are active."""
    use_vec = mode in ("hybrid", "hybrid_bm25", "vector")
    use_fts = mode in ("hybrid", "fts")
    use_bm25 = mode in ("hybrid_bm25", "bm25")

    ctes = []
    if use_vec:
        ctes.append("""
        vec AS (
          SELECT id, dist, ROW_NUMBER() OVER (ORDER BY dist) AS rnk
          FROM (SELECT id, embedding <=> %(qvec)s::vector AS dist
                FROM copilot.chunks ORDER BY dist LIMIT %(cand)s) v
        )""")
    
    if use_fts:
        ctes.append("""
        kw AS (
          SELECT id, score, ROW_NUMBER() OVER (ORDER BY score DESC) AS rnk
          FROM (SELECT id, ts_rank_cd(tsv, 
                  (SELECT string_agg(lexeme, ' | ') 
                   FROM unnest(to_tsvector('english', %(q)s)))::tsquery
                ) AS score
                FROM copilot.chunks 
                WHERE tsv @@ (SELECT string_agg(lexeme, ' | ') 
                               FROM unnest(to_tsvector('english', %(q)s)))::tsquery
                ORDER BY score DESC LIMIT %(cand)s) k
        )""")
        
    if use_bm25:
        ctes.append("""
        kw AS (
          SELECT id, score, ROW_NUMBER() OVER (ORDER BY score ASC) AS rnk
          FROM (SELECT id, tsv <@> to_bm25query(to_tsvector('english', %(q)s), 'copilot.chunks_bm25'::regclass) AS score
                FROM copilot.chunks 
                ORDER BY score ASC LIMIT %(cand)s) k
        )""")

    with_clause = "WITH " + ",\n".join(ctes) if ctes else ""

    select = """
    SELECT c.id AS chunk_id,
           s.id AS section_id,
           d.title AS document_title,
           d.issuer,
           s.section_path,
           d.source_path,
           c.content AS chunk_content,
           s.content AS section_content,
           c.content_sha,
           d.doc_type,
    """

    if use_vec and (use_fts or use_bm25):
        select += """
           vec.rnk AS vector_rank,
           kw.rnk AS fts_rank,
           COALESCE(1.0/(%(rrfk)s + vec.rnk), 0) + COALESCE(1.0/(%(rrfk)s + kw.rnk), 0) AS final_score,
           vec.dist AS vector_dist
        FROM copilot.chunks c
        JOIN copilot.sections s ON s.id = c.section_id
        JOIN copilot.documents d ON d.id = s.document_id
        LEFT JOIN vec ON vec.id = c.id
        LEFT JOIN kw  ON kw.id  = c.id
        WHERE vec.id IS NOT NULL OR kw.id IS NOT NULL
        ORDER BY final_score DESC
        LIMIT %(limit)s;
        """
    elif use_vec:
        select += """
           vec.rnk AS vector_rank,
           CAST(NULL AS integer) AS fts_rank,
           vec.dist AS final_score,
           vec.dist AS vector_dist
        FROM copilot.chunks c
        JOIN copilot.sections s ON s.id = c.section_id
        JOIN copilot.documents d ON d.id = s.document_id
        JOIN vec ON vec.id = c.id
        ORDER BY final_score ASC
        LIMIT %(limit)s;
        """
    elif use_fts:
        select += """
           CAST(NULL AS integer) AS vector_rank,
           kw.rnk AS fts_rank,
           kw.score AS final_score,
           CAST(NULL AS double precision) AS vector_dist
        FROM copilot.chunks c
        JOIN copilot.sections s ON s.id = c.section_id
        JOIN copilot.documents d ON d.id = s.document_id
        JOIN kw ON kw.id = c.id
        ORDER BY final_score DESC
        LIMIT %(limit)s;
        """
    elif use_bm25:
        select += """
           CAST(NULL AS integer) AS vector_rank,
           kw.rnk AS fts_rank,
           kw.score AS final_score,
           CAST(NULL AS double precision) AS vector_dist
        FROM copilot.chunks c
        JOIN copilot.sections s ON s.id = c.section_id
        JOIN copilot.documents d ON d.id = s.document_id
        JOIN kw ON kw.id = c.id
        ORDER BY final_score ASC
        LIMIT %(limit)s;
        """

    return with_clause + select, use_vec, use_fts, use_bm25


def retrieve(
    query: str,
    mode: Literal["vector", "fts", "bm25", "hybrid", "hybrid_bm25"] = "hybrid",
    k: int = 5,
    candidates: int = 50,
    rrf_k: int = 60,
    doc_type: str | None = None,
    expand_to_section: bool = True,
) -> list[Retrieved]:
    """Retrieve chunks for a query."""
    sql, use_vec, use_fts, use_bm25 = _build_sql(mode)
    
    qvec = embed_query(query) if use_vec else None
    
    params = {
        "q": query,
        "qvec": qvec,
        "cand": candidates,
        "rrfk": rrf_k,
        "limit": candidates * 3,
    }

    # HNSW iterative scan (pgvector 0.8) could filter in SQL.
    # We retrieve unfiltered and filter in Python because approximate
    # neighbour search doesn't compose well with WHERE filters in 0.7.
    
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute("SET LOCAL hnsw.ef_search = 100")
            cur.execute(sql, params)
            rows = cur.fetchall()

    results = []
    seen_sha = set()
    seen_section = set()

    for row in rows:
        (chunk_id, section_id, title, issuer, sec_path, src_path,
         chunk_content, sec_content, sha, dt, v_rnk, f_rnk, score, v_dist) = row

        if doc_type and dt != doc_type:
            continue

        if sha in seen_sha:
            continue
        seen_sha.add(sha)

        if expand_to_section:
            if section_id in seen_section:
                continue
            seen_section.add(section_id)
            content = sec_content
        else:
            content = chunk_content

        rrf_score = float(score) if mode in ("hybrid", "hybrid_bm25") else 0.0
        ranks = RankBreakdown(vector_rank=v_rnk, fts_rank=f_rnk, rrf_score=rrf_score)
        
        final_score = float(score)

        results.append(Retrieved(
            chunk_id=chunk_id,
            section_id=section_id,
            document_title=title,
            issuer=issuer,
            section_path=sec_path,
            source_url=src_path,
            content=content,
            score=final_score,
            vector_dist=float(v_dist) if v_dist is not None else None,
            ranks=ranks,
        ))

        if len(results) == k:
            break

    return results


def format_for_llm(results: list[Retrieved], start: int = 1) -> str:
    """Format retrieved results for LLM consumption.

    `start` offsets the passage numbers. The agent may search more than once
    while answering, and every passage has to keep a unique number so an [n]
    citation in the final answer still resolves to the passage it came from.
    """
    parts = []
    for i, r in enumerate(results, start):
        header = f"[{i}] {r.document_title}"
        if r.issuer:
            header += f" ({r.issuer})"
        header += f" — {r.section_path}"
        parts.append(f"{header}\n{r.content}")
    return "\n\n".join(parts)


if __name__ == "__main__":
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("query", help="Query string")
    parser.add_argument("--mode", choices=["vector", "fts", "bm25", "hybrid"], default="hybrid")
    parser.add_argument("-k", type=int, default=5)
    args = parser.parse_args()

    results = retrieve(args.query, mode=args.mode, k=args.k)
    for i, r in enumerate(results, 1):
        print(f"[{i}] score={r.score:.4f} vec_rank={r.ranks.vector_rank} fts_rank={r.ranks.fts_rank} vec_dist={r.vector_dist}")
        print(f"    {r.document_title} ({r.issuer or 'internal'})")
        print(f"    {r.section_path}")
        print(f"    {r.content[:200]!r}")
        print()
