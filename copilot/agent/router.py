"""Agent loop: route a question to tools, then answer from what they returned.

The model picks the tools. This module runs them and keeps the bookkeeping the
/ask contract needs (route taken, citations, latency).

It is a *bounded loop* rather than a single dispatch because real questions
cross both halves of the system — "was this suspension consistent with policy?"
needs the driver's record and the policy corpus. Sequential rounds let the
model see one tool's answer before deciding whether it needs another, which is
also what stops multiple tool calls in one round from being silently dropped.
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

# Ensure transit-ops2 is in sys.path so 'copilot.x' imports work from anywhere
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

from copilot.agent.prompts import SYSTEM_PROMPT
from copilot.agent.tools import (
    DATABASE_TOOLS,
    DATABASE_TOOLS_BY_NAME,
    search_policy_documents,
)
from copilot.retrieval.search import format_for_llm, retrieve

# Provisional refusal threshold based on prior vector eval score distribution.
# Will be updated once the CMVR splitter bug is fixed and full distribution is known.
REFUSAL_THRESHOLD = 0.35

# Each round is one tool call, so a mixed question that looks up a driver, then
# their history, then the governing policy needs three before it can answer.
# Four leaves that headroom without letting a confused model loop forever.
MAX_TOOL_ROUNDS = 4

from copilot.agent.llm_manager import LLMFallbackManager

# Instantiate the singleton key manager that handles rotation and rate limits
llm_manager = LLMFallbackManager()

# Ceiling on rows echoed back to the client in the `rows` field. The model has
# already seen the full result; this only bounds the debug payload.
MAX_RESULT_ROWS = 50

REFUSAL_TEXT = (
    "I do not have enough confidence to answer this question based on the retrieved documents."
)
WEAK_RETRIEVAL_NOTE = (
    "No passage in the policy corpus was close enough to this question to be worth quoting. "
    "Do not cite any document. Answer from the other tool results if there are any, and say "
    "plainly that the policy position could not be confirmed."
)
FINAL_TURN_NOTE = (
    "You have used all the tool calls available for this question. Answer it now from the tool "
    "results above, and do not request another tool."
)


# The model cites as [1] but sometimes reaches for the fullwidth 【1】 instead.
# Both are the same citation; missing the second silently drops real sources.
_CITATION_RE = re.compile(r"[\[【](\d+)[\]】]")


def _extract_citations(answer: str, results_len: int) -> tuple[list[int], list[int]]:
    """Parse [n] citations from the answer and validate them."""
    matches = _CITATION_RE.findall(answer)
    valid, invalid = [], []
    for m in matches:
        idx = int(m)
        if 1 <= idx <= results_len:
            if idx not in valid:
                valid.append(idx)
        else:
            if idx not in invalid:
                invalid.append(idx)
    return valid, invalid


def _coerce_text(content: Any) -> str:
    """Flatten the model's content, which may arrive as a list of blocks."""
    if isinstance(content, list):
        return "".join(
            block.get("text", "") if isinstance(block, dict) else str(block) for block in content
        )
    return content or ""


def _reduce_route(routes: list[str]) -> str:
    """Which half of the system actually answered."""
    used_kb = "documents" in routes
    used_db = "database" in routes
    if used_kb and used_db:
        return "mixed"
    if used_db:
        return "database"
    if used_kb:
        return "documents"
    return "refused"


def _cap_rows(entries: list[dict]) -> list[dict]:
    """Trim the row payload sent to the client to a sane size.

    Lists inside a tool result are truncated once the budget runs out, and the
    truncation is marked rather than left to look like the whole answer.
    """
    remaining = MAX_RESULT_ROWS
    capped = []
    for entry in entries:
        result = entry.get("result")
        if not isinstance(result, dict):
            capped.append(entry)
            continue
        trimmed = {}
        for key, value in result.items():
            if isinstance(value, list) and value:
                if len(value) > remaining:
                    trimmed[key] = value[:remaining]
                    trimmed[key + "_truncated"] = True
                    remaining = 0
                else:
                    trimmed[key] = value
                    remaining -= len(value)
            else:
                trimmed[key] = value
        capped.append({"tool": entry["tool"], "result": trimmed})
    return capped


def _payload(
    *,
    started: float,
    mode: str,
    route: str,
    answer: str,
    refused: bool = False,
    top1_distance: float | None = None,
    citations: list | None = None,
    invalid_citations: list | None = None,
    sql: list | None = None,
    rows: list | None = None,
    multi_tool_requested: bool = False,
    model_name: str,
) -> dict[str, Any]:
    """Build the full AskData key set.

    Every exit from ask() goes through here, because main.py splats this
    straight into the AskData model and reads top1_distance unconditionally —
    a return path missing a key is a 500, not a degraded answer.
    """
    return {
        "route": route,
        "answer": answer,
        "refused": refused,
        "top1_distance": top1_distance,
        "citations": citations or [],
        "invalid_citations": invalid_citations or [],
        "sql": sql or None,
        "rows": rows or None,
        "multi_tool_requested": multi_tool_requested,
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "model": model_name,
        "retrieval_mode": mode,
    }


def ask(question: str, mode: str = "hybrid_bm25", k: int = 5, verbose: bool = False, on_progress: Any = None) -> dict[str, Any]:
    started = time.perf_counter()

    def emit(step: str, label: str, toast: bool = False) -> None:
        if on_progress is not None:
            on_progress({"type": "progress", "step": step, "label": label, "toast": toast})

    emit("init", "Analyzing your question\u2026")

    messages = [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=question),
    ]

    routes: list[str] = []
    passages: list = []  # every retrieved passage, numbered continuously
    tool_log: list[dict] = []  # -> AskData.sql
    row_log: list[dict] = []  # -> AskData.rows
    tool_digests: list[str] = []  # plain-text tool output, for the fallback below
    top1_distance: float | None = None
    multi_tool_requested = False
    answer = ""

    used_model_name = "unknown"

    def record(content: str, call_id: str) -> None:
        """Hand one tool's output back to the model, and keep a copy."""
        tool_digests.append(content)
        messages.append(ToolMessage(content=content, tool_call_id=call_id))

    for round_index in range(MAX_TOOL_ROUNDS):
        emit("thinking", f"Thinking (round {round_index + 1})\u2026" if round_index > 0 else "Selecting tools\u2026")
        
        def execute_round(llm):
            llm_with_tools = llm.bind_tools([search_policy_documents, *DATABASE_TOOLS])
            return llm_with_tools.invoke(messages)
            
        response, used_model_name = llm_manager.invoke_with_fallback(emit, execute_round)
        messages.append(response)
        tool_calls = response.tool_calls or []

        if not tool_calls:
            # The model is done calling tools; this response is the answer.
            emit("generating", "Generating answer\u2026")
            answer = _coerce_text(response.content)
            break

        if len(tool_calls) > 1:
            multi_tool_requested = True
            if verbose:
                print(f"Multi-tool round: {[c['name'] for c in tool_calls]}")

        for call in tool_calls:
            name = call["name"]
            args = call.get("args") or {}
            call_id = call["id"]
            tool_log.append({"tool": name, "args": args})

            if verbose:
                print(f"[round {round_index + 1}] {name} {args}")

            if name == "search_policy_documents":
                emit("searching_docs", "Searching policy documents\u2026")
                routes.append("documents")
                results = retrieve(
                    args.get("query", question), mode=mode, k=k, expand_to_section=True
                )

                distance = None
                if results and results[0].vector_dist is not None:
                    distance = results[0].vector_dist
                    if top1_distance is None or distance < top1_distance:
                        top1_distance = distance

                weak = distance is not None and distance > REFUSAL_THRESHOLD
                only_tool_so_far = round_index == 0 and len(tool_calls) == 1

                if weak and only_tool_so_far:
                    # Pure document question with nothing close enough: refuse
                    # outright rather than pay for a synthesis call.
                    return _payload(
                        started=started,
                        mode=mode,
                        route="refused",
                        answer=REFUSAL_TEXT,
                        refused=True,
                        top1_distance=top1_distance,
                        sql=tool_log,
                        multi_tool_requested=multi_tool_requested,
                        model_name=used_model_name,
                    )

                if weak:
                    # Something else in this answer may still stand on its own.
                    content = WEAK_RETRIEVAL_NOTE
                else:
                    content = format_for_llm(results, start=len(passages) + 1)
                    passages.extend(results)

                if verbose:
                    for i, r in enumerate(results, 1):
                        print(f"  [{i}] {r.document_title} — {r.section_path} (dist: {r.vector_dist})")

                record(content, call_id)

            elif name in DATABASE_TOOLS_BY_NAME:
                emit("querying_db", f"Querying database \u2014 {name}\u2026")
                routes.append("database")
                try:
                    result = DATABASE_TOOLS_BY_NAME[name](**args)
                except TypeError as exc:
                    # The model invented an argument. Tell it, rather than 500.
                    result = {
                        "status": "invalid_params",
                        "message": f"{name} does not accept those arguments ({exc}).",
                    }
                except Exception:  # pragma: no cover — defensive
                    result = {
                        "status": "error",
                        "message": f"{name} failed while reading the database.",
                    }
                row_log.append({"tool": name, "result": result})
                record(json.dumps(result, default=str), call_id)

            else:
                record(
                    json.dumps({"status": "unknown_tool", "message": f"No tool named {name}."}),
                    call_id,
                )
    else:
        # Rounds exhausted with the model still asking for tools. Tell it to
        # answer, and drop the tools so it cannot ask for another.
        messages.append(HumanMessage(content=FINAL_TURN_NOTE))
        emit("generating", "Generating answer (final attempt)\u2026")
        try:
            response, used_model_name = llm_manager.invoke_with_fallback(emit, lambda llm: llm.invoke(messages))
            answer = _coerce_text(response.content)
        except Exception:
            # Groq rejects a tool call made when no tools are offered, so a
            # model determined to keep calling them 400s here. Re-ask with the
            # tool output flattened into plain text: with no tool-call
            # structure to continue, there is nothing for it to call.
            digest = "\n\n".join(tool_digests)
            
            def execute_digest(llm):
                return llm.invoke([
                    SystemMessage(content=SYSTEM_PROMPT),
                    HumanMessage(content=f"{question}\n\nTool results:\n{digest}\n\n{FINAL_TURN_NOTE}")
                ])
                
            response, used_model_name = llm_manager.invoke_with_fallback(emit, execute_digest)
            answer = _coerce_text(response.content)

    emit("finalizing", "Preparing response\u2026")

    if not routes:
        # The model answered without consulting anything. Nothing grounds this,
        # so it is a refusal, exactly as before.
        return _payload(
            started=started,
            mode=mode,
            route="refused",
            answer=answer or "I am not able to answer this question without a tool.",
            refused=True,
            multi_tool_requested=multi_tool_requested,
            model_name=used_model_name,
        )

    if not passages:
        # A database-only answer has no passages to point at, so any bracketed
        # number the model reached for refers to nothing. Drop the markers
        # rather than reporting them as invalid citations — there is no broken
        # citation here to warn anyone about, just noise in the prose.
        answer = _CITATION_RE.sub("", answer).replace(" .", ".").replace(" ,", ",")

    valid_citations, invalid_citations = _extract_citations(answer, len(passages))
    citations = [
        {
            "document": passages[idx - 1].document_title,
            "issuer": passages[idx - 1].issuer,
            "section_path": passages[idx - 1].section_path,
            "score": passages[idx - 1].score,
        }
        for idx in valid_citations
    ]

    return _payload(
        started=started,
        mode=mode,
        route=_reduce_route(routes),
        answer=answer,
        top1_distance=top1_distance,
        citations=citations,
        invalid_citations=invalid_citations,
        sql=tool_log,
        rows=_cap_rows(row_log),
        multi_tool_requested=multi_tool_requested,
        model_name=used_model_name,
    )


if __name__ == "__main__":
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("question", help="Question")
    parser.add_argument("--mode", default="hybrid_bm25")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    res = ask(args.question, mode=args.mode, verbose=args.verbose)
    print("ROUTE:", res["route"])
    print("ANSWER:", res["answer"])
    print("CITATIONS:", res["citations"])
    if res["invalid_citations"]:
        print("INVALID CITATIONS:", res["invalid_citations"])
    if res["sql"]:
        print("TOOLS:", json.dumps(res["sql"], indent=2, default=str))
