"""Map evaluation gold_source locators to database section IDs."""

import argparse
import json
import os
import re
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def _resolve_sop(cur, doc_slug: str, locator: str) -> set[int]:
    """Resolve DAP-3.2, ABR-2.1, ABR-6 etc."""
    prefix, num = locator.split("-", 1)
    # Check if section_path ends with ' > num', contains ' > num >', or starts with 'num. '
    cur.execute(
        "SELECT s.id, s.section_path FROM copilot.sections s "
        "JOIN copilot.documents d ON d.id = s.document_id "
        "WHERE d.source_path LIKE %s",
        (f"%{doc_slug}%",)
    )
    ids = set()
    for sid, path in cur.fetchall():
        if path.endswith(f" > {num}") or f" > {num} >" in path or path.startswith(f"{num}. "):
            ids.add(sid)
    return ids


def _resolve_act(cur, doc_slug: str, locator: str) -> set[int]:
    """Resolve Section 134, Section 15(2), #s134."""
    m = re.search(r'(?:Section |#s)(\d+[A-Za-z]?)', locator, re.IGNORECASE)
    if not m:
        return set()
    num = m.group(1)
    
    cur.execute(
        "SELECT s.id, s.section_path FROM copilot.sections s "
        "JOIN copilot.documents d ON d.id = s.document_id "
        "WHERE d.source_path LIKE %s",
        (f"%{doc_slug}%",)
    )
    ids = set()
    for sid, path in cur.fetchall():
        # Look for "Section 134." or "Section 134 " or "Section 134-"
        if re.search(fr'\bSection {num}[.\s—-]', path, re.IGNORECASE):
            ids.add(sid)
    return ids


def _resolve_cmvr(cur, doc_slug: str, locator: str) -> set[int]:
    """Resolve Rule 62, #r129a."""
    m = re.search(r'(?:Rule |#r)(\d+[A-Za-z]?)', locator, re.IGNORECASE)
    if not m:
        return set()
    num = m.group(1)
    
    cur.execute(
        "SELECT s.id, s.section_path FROM copilot.sections s "
        "JOIN copilot.documents d ON d.id = s.document_id "
        "WHERE d.source_path LIKE %s",
        (f"%{doc_slug}%",)
    )
    ids = set()
    for sid, path in cur.fetchall():
        # Match both "Section N." (old ingest) and "Rule N." (new ingest)
        if re.search(fr'\b(?:Rule|Section) {num}[.\s—-]', path, re.IGNORECASE):
            ids.add(sid)
    return ids


def _resolve_insurance(cur, doc_slug: str, locator: str) -> set[int]:
    """Resolve Section IV, Condition 11, IMT-23."""
    cur.execute(
        "SELECT s.id, s.section_path, s.content FROM copilot.sections s "
        "JOIN copilot.documents d ON d.id = s.document_id "
        "WHERE d.source_path LIKE %s",
        (f"%{doc_slug}%",)
    )
    ids = set()
    
    if locator.startswith("Condition "):
        for sid, path, _ in cur.fetchall():
            if path.strip() == locator.strip():
                ids.add(sid)
                
    elif locator.startswith("SECTION I") or locator.startswith("Section I"):
        m = re.match(r'(SECTION\s+[IVX]+)', locator, re.IGNORECASE)
        if m:
            prefix = m.group(1).upper()
            for sid, path, _ in cur.fetchall():
                # Avoid SECTION I matching SECTION IV
                # ^SECTION\s+I(?![IVX])
                pat = r'^' + re.escape(prefix) + r'(?![IVX])'
                if re.search(pat, path, re.IGNORECASE):
                    ids.add(sid)
                    
    elif locator.startswith("IMT"):
        m = re.search(r'IMT[-.\s]?(\d+[A-Za-z]?)', locator, re.IGNORECASE)
        if m:
            num = m.group(1)
            rows = cur.fetchall()
            # Try path first
            for sid, path, _ in rows:
                if re.search(fr'IMT[-.\s]?{num}\b', path, re.IGNORECASE):
                    ids.add(sid)
            if not ids:
                # Fallback to content
                for sid, _, content in rows:
                    if re.search(fr'IMT[-.\s]?{num}\b', content, re.IGNORECASE):
                        ids.add(sid)
    
    return ids


def resolve_locator(cur, document_path: str, locator: str) -> set[int]:
    """Return set of copilot.sections.id matching the locator."""
    # Handle compound locators
    if " / " in locator:
        ids = set()
        for part in locator.split(" / "):
            ids |= resolve_locator(cur, document_path, part.strip())
        return ids

    slug = document_path.split("/")[-1].replace(".pdf", "").replace(".md", "")
    
    if slug.startswith("driver-allowance") or slug.startswith("accident") or slug.startswith("fuel-card") or slug.startswith("preventive"):
        return _resolve_sop(cur, slug, locator)
    elif "VehiclesAct" in slug or "Workers-Act" in slug:
        return _resolve_act(cur, slug, locator)
    elif "CMVR" in slug:
        return _resolve_cmvr(cur, slug, locator)
    elif "Policy" in slug or "Add-ons" in slug:
        return _resolve_insurance(cur, slug, locator)
        
    return set()


def resolve_all(cur, eval_path: Path) -> dict[str, list[dict]]:
    """Resolve all gold_source entries across the eval set."""
    resolved = {}
    
    print("GOLD SOURCE RESOLUTION REPORT")
    print("==============================")
    
    with eval_path.open() as f:
        lines = f.readlines()
        
    total_locators = 0
    resolved_count = 0
    unresolved_count = 0
    over_count = 0
    
    for line in lines:
        if not line.strip(): continue
        item = json.loads(line)
        qid = item["id"]
        
        resolved[qid] = []
        if not item.get("gold_source"):
            continue
            
        for g in item["gold_source"]:
            doc = g["document"]
            loc = g["locator"]
            sids = resolve_locator(cur, doc, loc)
            resolved[qid].append({
                "document": doc,
                "locator": loc,
                "section_ids": sids
            })
            
            total_locators += 1
            n = len(sids)
            if n == 0:
                print(f"{qid:4} {loc[:20]:20} → {doc[:30]:30} → 0 section(s)  ⚠ UNRESOLVED")
                unresolved_count += 1
            elif n > 3:
                print(f"{qid:4} {loc[:20]:20} → {doc[:30]:30} → {n} section(s)  ⚠ OVER-RESOLVED")
                over_count += 1
            else:
                print(f"{qid:4} {loc[:20]:20} → {doc[:30]:30} → {n} section(s)  ✓")
                resolved_count += 1

    print(f"\nSummary: {total_locators} locators")
    print(f"  Resolved (1-3 sections):  {resolved_count}")
    print(f"  Unresolved (0 sections):   {unresolved_count}")
    print(f"  Over-resolved (>3):        {over_count}")
    
    return resolved


if __name__ == "__main__":
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    eval_path = Path(__file__).resolve().parents[2] / "data" / "_eval" / "eval_set.jsonl"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            resolve_all(cur, eval_path)
