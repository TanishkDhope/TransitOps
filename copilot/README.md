# TransitOps Copilot service

FastAPI microservice for the "knowledge + query copilot" feature. This is the
first vertical slice: it proves the request path **React → Express → FastAPI →
back** with auth and RBAC enforced upstream in Express. For now `/ask` simply
**echoes** the request so the plumbing is observable.

Later slices add embeddings + pgvector, document retrieval, schema-prompted
NL→SQL, Gemini calls, streaming, and conversation history — all behind the
unchanged `/ask` contract. Those spots are marked `# TODO` in `main.py`.

## Boundaries

- Binds to **`127.0.0.1` (loopback) only** — it is never reachable from the
  browser. Express (`server/`) is the sole caller.
- Every route **except `/health`** requires an `x-internal-token` header that
  matches `INTERNAL_SERVICE_TOKEN`. Missing/wrong token → `401`.

## Knowledge corpus (future retrieval slice)

When the retrieval slice lands, the ingester must scope the corpus glob
**positively** to `data/internal/**/*.{pdf,md}` (plus the public reference PDFs in
`data/`) — never a blanket `data/**`. This is deliberate: `data/_eval/` holds
**eval ground truth** (`CANON.md` — the fact sheet the copilot's answers are scored
against) and must **never** enter the corpus, or the model would be reading the
answer key. The underscore prefix marks it; any directory whose name begins with `_`
is to be skipped. Each file under `data/_eval/` also carries a `DO NOT INGEST`
banner as a second line of defence, but the glob scope is the primary guard.

## Tooling

Managed with [uv](https://docs.astral.sh/uv/). Dependencies live in
`pyproject.toml` / `uv.lock` — do not add a `requirements.txt`.

## Running

```bash
cd copilot
cp .env.example .env          # then set INTERNAL_SERVICE_TOKEN (match server/.env)
uv sync                        # install deps into a managed venv
uv run uvicorn main:app --host 127.0.0.1 --port 8100 --reload
```

From the repo root, `npm run dev` starts this service alongside the Express API.

## Endpoints

| Method | Path      | Auth            | Purpose                                  |
| ------ | --------- | --------------- | ---------------------------------------- |
| GET    | `/health` | none            | Liveness; `{ ok, service, version, llmEnabled: false }` |
| POST   | `/ask`    | `x-internal-token` | Echoes the question back (see contract below) |

### `POST /ask`

Request:

```json
{ "question": "test question", "role": "DISPATCHER", "capabilities": ["trip:read"], "requestId": "<uuid>" }
```

Response:

```json
{
  "answer": "<echo> You asked: 'test question' as DISPATCHER with 1 capabilities.",
  "sources": [],
  "tool": "echo",
  "latencyMs": 0,
  "requestId": "<uuid>"
}
```

`question` must be non-empty and ≤ 500 characters, else `422`.

## Quick check

```bash
# health needs no token
curl http://127.0.0.1:8100/health

# /ask without the token is rejected
curl -X POST http://127.0.0.1:8100/ask -H "content-type: application/json" \
  -d '{"question":"hi","role":"ADMIN","capabilities":[],"requestId":"1"}'
# -> 401
```
