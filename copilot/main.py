"""TransitOps Copilot — knowledge + query service.

Request path is React -> Express -> FastAPI, with auth and RBAC enforced
upstream in Express. /ask hands the question to the agent in
copilot/agent/router.py, which routes it to the document corpus (pgvector +
BM25 retrieval), to the read-only operational database tools, or to both.

It binds to 127.0.0.1 (loopback) only and is never exposed to the browser;
Express is the sole caller. Every route except /health requires the shared
`x-internal-token` header.

TODO (later slices): streaming and conversation history, both of which slot in
behind the unchanged /ask contract.
"""

import json
import logging
import os
import sys
import threading
import time
from pathlib import Path
from queue import Queue

# Ensure transit-ops2 is in sys.path so 'copilot.x' imports work
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from starlette.responses import StreamingResponse

load_dotenv()

SERVICE_NAME = "copilot"
SERVICE_VERSION = "0.1.0"
QUESTION_MAX_LEN = 500

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(SERVICE_NAME)

app = FastAPI(title="TransitOps Copilot", version=SERVICE_VERSION)


# ---------------------------------------------------------------------------
# Auth: shared internal token. Every route but /health depends on this.
# ---------------------------------------------------------------------------
def require_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    """Reject any caller that does not present the shared internal token.

    Implemented as a dependency so it is impossible to add a new route and
    forget to guard it — apply `Depends(require_internal_token)` and it is done.
    """
    expected = os.environ.get("INTERNAL_SERVICE_TOKEN")
    if not expected or x_internal_token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal service token.",
        )


# ---------------------------------------------------------------------------
# Models — typed request/response, no bare dicts.
# ---------------------------------------------------------------------------
class AskRequest(BaseModel):
    question: str = Field(..., description="The user's natural-language question.")
    role: str = Field(..., description="Caller's role, already authorized by Express.")
    # TODO: gates view access in the SQL slice — forwarded now so the contract
    # is pinned and no signature changes when retrieval/scoping lands.
    capabilities: list[str] = Field(default_factory=list)
    requestId: str = Field(..., description="Correlation id minted by Express.")

    @field_validator("question")
    @classmethod
    def _question_non_empty_and_bounded(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("question must not be empty.")
        if len(trimmed) > QUESTION_MAX_LEN:
            raise ValueError(f"question must be at most {QUESTION_MAX_LEN} characters.")
        return trimmed


class Citation(BaseModel):
    document: str
    issuer: str | None
    section_path: str
    score: float

class AskData(BaseModel):
    route: str = Field(
        ...,
        description='Which source answered: "documents", "database", "mixed" or "refused".',
    )
    answer: str
    refused: bool
    top1_distance: float | None = None
    citations: list[Citation] = Field(default_factory=list)
    invalid_citations: list[int] = Field(default_factory=list)
    # The database side is a fixed set of parameterised tools, not generated
    # SQL, so this carries the calls that ran rather than a query string.
    sql: list[dict] | None = Field(
        default=None, description="Tools executed, as {tool, args}. Null for document-only answers."
    )
    rows: list[dict] | None = Field(
        default=None, description="Tool results, as {tool, result}. Capped; may be truncated."
    )
    multi_tool_requested: bool
    latency_ms: int
    model: str
    retrieval_mode: str
    requestId: str

class AskResponse(BaseModel):
    success: bool
    message: str
    data: AskData


class HealthResponse(BaseModel):
    ok: bool
    service: str
    version: str
    llmEnabled: bool


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Unauthenticated liveness probe. Express proxies this for its status check."""
    return HealthResponse(
        ok=True,
        service=SERVICE_NAME,
        version=SERVICE_VERSION,
        llmEnabled=True,
    )


@app.post("/ask", response_model=AskResponse, dependencies=[Depends(require_internal_token)])
def ask_route(payload: AskRequest) -> AskResponse:
    from copilot.agent.router import ask
    
    logger.info(
        "ask requestId=%s role=%s question=%r capabilities=%d",
        payload.requestId,
        payload.role,
        payload.question,
        len(payload.capabilities),
    )

    res = ask(payload.question, mode="bm25", k=5, verbose=False)
    
    # Extend the audit summary with route and top1_distance
    logger.info(
        "ask_complete requestId=%s route=%s top1_distance=%s latency_ms=%d",
        payload.requestId,
        res["route"],
        res["top1_distance"],
        res["latency_ms"]
    )

    # Attach requestId to the data
    res["requestId"] = payload.requestId

    return AskResponse(
        success=True,
        message="OK",
        data=AskData(**res)
    )


@app.post("/ask/stream", dependencies=[Depends(require_internal_token)])
def ask_stream_route(payload: AskRequest):
    """SSE endpoint: streams progress events, then the final result."""
    from copilot.agent.router import ask

    logger.info(
        "ask_stream requestId=%s role=%s question=%r",
        payload.requestId,
        payload.role,
        payload.question,
    )

    progress_queue: Queue = Queue()
    result_holder: list = [None]
    error_holder: list = [None]

    def on_progress(event: dict) -> None:
        progress_queue.put(event)

    def worker() -> None:
        try:
            res = ask(
                payload.question, mode="bm25", k=5, verbose=False, on_progress=on_progress
            )
            result_holder[0] = res
        except Exception as exc:
            logger.exception("ask_stream worker failed requestId=%s", payload.requestId)
            error_holder[0] = exc
        finally:
            progress_queue.put(None)  # sentinel

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    def event_stream():
        while True:
            item = progress_queue.get()
            if item is None:
                break
            yield f"data: {json.dumps(item)}\n\n"

        if error_holder[0] is not None:
            yield f"data: {json.dumps({'type': 'error', 'message': str(error_holder[0])})}\n\n"
        elif result_holder[0] is not None:
            res = result_holder[0]
            res["requestId"] = payload.requestId
            logger.info(
                "ask_stream_complete requestId=%s route=%s latency_ms=%d",
                payload.requestId,
                res["route"],
                res["latency_ms"],
            )
            yield f"data: {json.dumps({'type': 'result', 'data': res}, default=str)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
