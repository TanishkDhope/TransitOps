import json
import time
from collections import defaultdict
from pathlib import Path
from datetime import datetime

import sys
import os
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from dotenv import load_dotenv
from copilot.agent.router import ask
from copilot.eval.run_eval import get_corpus_version

# Need to set up environment
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

def run_router_eval():
    eval_set_path = Path(__file__).resolve().parents[2] / "data" / "_eval" / "eval_set.jsonl"
    out_path = Path(__file__).resolve().parents[2] / "data" / "_eval" / "router_runs.jsonl"
    
    questions = []
    with open(eval_set_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                questions.append(json.loads(line))
                
    expected_vs_actual = defaultdict(lambda: defaultdict(int))
    category_totals = defaultdict(int)
    category_correct = defaultdict(int)
    both_selections = defaultdict(int)
    
    refuse_outcomes = {"refused_by_threshold": 0, "refused_by_answer": 0, "failed_to_refuse": 0}
    
    start_time = time.time()
    
    for q in questions:
        expected = q["route"]
        cat = q["category"]
        category_totals[cat] += 1
        
        res = ask(q["question"], mode="hybrid_bm25", k=5, verbose=False)
        actual = res["route"]
        
        if expected == "both":
            both_selections[actual] += 1
            expected_vs_actual[expected][actual] += 1
            # We don't count 'both' in accuracy failure.
            continue
            
        if expected == "refuse":
            if actual == "refused":
                refuse_outcomes["refused_by_threshold"] += 1
                category_correct[cat] += 1
                expected_vs_actual[expected]["refused"] += 1
            elif actual == "documents":
                ans = res["answer"].lower()
                # Check if it gracefully answers it doesn't know
                if "not contain" in ans or "not explicitly covered" in ans or "do not have" in ans or "not mentioned" in ans or "no information" in ans or "cannot answer" in ans or "does not cover" in ans or "not provided" in ans or "not detail" in ans:
                    refuse_outcomes["refused_by_answer"] += 1
                    category_correct[cat] += 1
                    expected_vs_actual[expected]["answered_missing"] += 1
                else:
                    refuse_outcomes["failed_to_refuse"] += 1
                    expected_vs_actual[expected]["hallucinated_or_failed"] += 1
            else:
                refuse_outcomes["failed_to_refuse"] += 1
                expected_vs_actual[expected][actual] += 1
            continue
            
        # expected == 'documents' or 'sql'
        if expected == "documents" and actual == "documents":
            category_correct[cat] += 1
        elif expected == "sql" and actual == "database":
            category_correct[cat] += 1
            
        expected_vs_actual[expected][actual] += 1
        
    run_time = time.time() - start_time
    
    print("\n=== ROUTER CONFUSION MATRIX (Expected x Actual) ===")
    for exp, actuals in expected_vs_actual.items():
        print(f"Expected: {exp}")
        for act, count in actuals.items():
            print(f"  -> {act}: {count}")
            
    print("\n=== ROUTER ACCURACY BY CATEGORY ===")
    overall_correct = sum(category_correct.values())
    # Subtract 'both' from total for accuracy calculation
    evaluable_total = len([q for q in questions if q["route"] != "both"])
    
    for cat, total in category_totals.items():
        correct = category_correct[cat]
        # Some categories might have 'both' route
        cat_evaluable = len([q for q in questions if q["category"] == cat and q["route"] != "both"])
        if cat_evaluable > 0:
            print(f"{cat}: {correct}/{cat_evaluable} ({(correct/cat_evaluable)*100:.1f}%)")
            
    print(f"\nOverall Evaluable Accuracy: {overall_correct}/{evaluable_total} ({(overall_correct/evaluable_total)*100:.1f}%)")
    
    print("\n=== REFUSE OUTCOMES ===")
    print(f"Refused by distance threshold: {refuse_outcomes['refused_by_threshold']}")
    print(f"Refused by LLM missing-data logic: {refuse_outcomes['refused_by_answer']}")
    print(f"Failed to refuse (answered anyway): {refuse_outcomes['failed_to_refuse']}")
    
    print("\n=== 'BOTH' ROUTE SELECTIONS ===")
    for act, count in both_selections.items():
        print(f"Chose {act}: {count}")
        
    # Append to router_runs.jsonl
    import psycopg2
    from copilot.retrieval.embed import POSTGRES_URL
    with psycopg2.connect(POSTGRES_URL) as conn:
        with conn.cursor() as cur:
            cv = get_corpus_version(cur)
            
    run_record = {
        "run_id": f"router-eval-{datetime.now().strftime('%Y%m%dT%H%M%S')}",
        "corpus_version": cv,
        "provisional": True,
        "known_issues": ["CMVR Section Splitter Bug"],
        "metrics": {
            "overall_accuracy": overall_correct / evaluable_total if evaluable_total > 0 else 0,
            "refuse_outcomes": refuse_outcomes,
            "both_selections": both_selections,
            "expected_vs_actual": expected_vs_actual,
            "category_accuracy": {
                c: (category_correct[c] / len([q for q in questions if q["category"] == c and q["route"] != "both"]))
                for c in category_totals if len([q for q in questions if q["category"] == c and q["route"] != "both"]) > 0
            }
        },
        "time_s": run_time
    }
    
    with open(out_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(run_record) + "\n")
        
    print(f"\nRun saved to {out_path.name}")

if __name__ == "__main__":
    run_router_eval()
