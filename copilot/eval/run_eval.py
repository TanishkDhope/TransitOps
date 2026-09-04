"""Evaluation loop for retrieval."""

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from copilot.eval.resolve import resolve_all
from copilot.retrieval.search import retrieve


EVAL_CATEGORIES = {
    "exact_citation", "conceptual", "near_duplicate",
    "internal_fact", "statutory_vs_internal", "refusal",
}
SKIP_CATEGORIES = {"sql", "ambiguous_route"}


def get_corpus_version(cur) -> str:
    cur.execute("SELECT md5(string_agg(content_sha, '' ORDER BY id)) FROM copilot.chunks")
    return cur.fetchone()[0]


def run_eval(mode: str):
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    eval_path = Path(__file__).resolve().parents[2] / "data" / "_eval" / "eval_set.jsonl"
    runs_path = Path(__file__).resolve().parents[2] / "data" / "_eval" / "runs.jsonl"
    misses_dir = Path(__file__).resolve().parents[2] / "data" / "_eval" / "misses"
    misses_dir.mkdir(parents=True, exist_ok=True)
    
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            resolved = resolve_all(cur, eval_path)
            corpus_version = get_corpus_version(cur)
            
    with eval_path.open() as f:
        questions = [json.loads(line) for line in f if line.strip()]
        
    metrics = defaultdict(lambda: {"n": 0, "hit@1": 0.0, "hit@5": 0.0, "hit@10": 0.0, "MRR": 0.0})
    refusal_metrics = {"n": 0, "top1_scores": [], "top1_distances": []}
    
    skipped_count = 0
    excluded_count = 0
    misses = []
    
    for q in questions:
        if q["category"] in SKIP_CATEGORIES:
            skipped_count += 1
            continue
            
        qid = q["id"]
        cat = q["category"]
        
        # Check if unresolved (only for non-refusal)
        if cat != "refusal":
            is_unresolved = False
            target_ids = set()
            for r in resolved[qid]:
                if not r["section_ids"]:
                    is_unresolved = True
                    break
                target_ids |= r["section_ids"]
                
            if is_unresolved:
                print(f"Skipping {qid}: unresolved gold source")
                excluded_count += 1
                continue
                
        results = retrieve(q["question"], mode=mode, k=10)
        
        top1_dist = results[0].vector_dist if results else None
        
        if cat == "refusal":
            refusal_metrics["n"] += 1
            refusal_metrics["top1_scores"].append(results[0].score if results else 0)
            if top1_dist is not None:
                refusal_metrics["top1_distances"].append(top1_dist)
            continue
            
        metrics[cat]["n"] += 1
        
        hit_rank = None
        for i, r in enumerate(results, 1):
            if r.section_id in target_ids:
                hit_rank = i
                break
                
        if hit_rank is not None:
            if hit_rank <= 1: metrics[cat]["hit@1"] += 1
            if hit_rank <= 5: metrics[cat]["hit@5"] += 1
            if hit_rank <= 10: metrics[cat]["hit@10"] += 1
            metrics[cat]["MRR"] += 1.0 / hit_rank
        else:
            # It's a miss
            misses.append({
                "qid": qid,
                "cat": cat,
                "question": q["question"],
                "gold": [f"{r['document']} → {r['locator']}" for r in resolved[qid]],
                "results": results[:3]
            })
            
    # Finalize metrics
    for cat in metrics:
        n = metrics[cat]["n"]
        if n > 0:
            metrics[cat]["hit@1"] /= n
            metrics[cat]["hit@5"] /= n
            metrics[cat]["hit@10"] /= n
            metrics[cat]["MRR"] /= n
            
    print(f"\nExcluded {excluded_count} questions: unresolved gold source")
    print(f"Skipped {skipped_count} questions: sql or ambiguous_route")
    
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    run_id = f"eval-{timestamp.replace(':', '').replace('-', '')[:15]}-{mode}"
    
    run_entry = {
        "run_id": run_id,
        "timestamp": timestamp,
        "provisional": True,
        "known_issues": ["cmvr-rules-body-unsplit"],
        "corpus_version": corpus_version,
        "chunker": {"target_tokens": 400, "ceiling_tokens": 600, "overlap_tokens": 60, "tokeniser": "cl100k_base"},
        "embedding": {"model": "gemini-embedding-001", "dimensions": 768},
        "mode": mode,
        "keyword_ranker": "ts_rank_cd" if mode in ("fts", "hybrid") else ("lakebase_text" if mode in ("bm25", "hybrid_bm25") else None),
        "rrf_k": 60,
        "ef_search": 100,
        "candidates": 50,
        "k": 10,
        "skipped_categories": list(SKIP_CATEGORIES),
        "skipped_count": skipped_count,
        "excluded_count": excluded_count,
        "metrics": dict(metrics)
    }
    if refusal_metrics["n"] > 0:
        run_entry["metrics"]["refusal"] = refusal_metrics
        
    with runs_path.open("a") as f:
        f.write(json.dumps(run_entry) + "\n")
        
    # Write misses
    if misses:
        # Sort by MRR ascending (all these are 0), so just dump
        miss_path = misses_dir / f"{run_id}.md"
        with miss_path.open("w", encoding="utf-8") as f:
            f.write(f"# Worst misses: {run_id}\n\n")
            for m in misses[:10]:
                f.write(f"## {m['qid']} — {m['cat']}\n")
                f.write(f"**Question:** {m['question']}\n")
                f.write(f"**Gold:** {', '.join(m['gold'])}\n\n")
                f.write("| Rank | Section Path | Score | Vec Dist | Vec | FTS |\n")
                f.write("|------|-------------|-------|----------|-----|-----|\n")
                for i, r in enumerate(m['results'], 1):
                    vd = f"{r.vector_dist:.4f}" if r.vector_dist is not None else "—"
                    vr = r.ranks.vector_rank if r.ranks.vector_rank is not None else "—"
                    fr = r.ranks.fts_rank if r.ranks.fts_rank is not None else "—"
                    f.write(f"| {i} | {r.section_path[:50]} | {r.score:.4f} | {vd} | {vr} | {fr} |\n")
                f.write("\n")
                
    print(f"Run completed: {run_id}")
    print(json.dumps(run_entry["metrics"], indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["vector", "fts", "bm25", "hybrid", "hybrid_bm25"], required=True)
    args = parser.parse_args()
    run_eval(args.mode)
