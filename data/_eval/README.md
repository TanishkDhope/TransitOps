<!-- ================================================================= -->
<!--  EVAL HARNESS DIRECTORY — MUST NEVER BE INGESTED.                 -->
<!--  Nothing in data/_eval/ is part of the retrieval corpus. See the  -->
<!--  "Never ingest" section below. Keep the ingestion glob scoped to   -->
<!--  data/internal/ and the public PDFs in data/, and skip any          -->
<!--  directory whose name begins with an underscore.                    -->
<!-- ================================================================= -->

# Copilot retrieval eval set

This directory holds the ground truth for scoring the copilot's retrieval/answering
quality. It is **not** corpus. Two artefacts:

- `CANON.md` — the fictional operator's fact sheet (the answer key the invented
  figures come from).
- `eval_set.jsonl` — 40 evaluation questions, one JSON object per line.

The documents the questions are answered *from* live elsewhere: the four SOPs in
`data/internal/` and the six public reference PDFs in `data/`.

## Distribution

Exactly these counts (verified against `eval_set.jsonl`):

| Category | Count | Route | What it probes |
|----------|-------|-------|----------------|
| `exact_citation` | 8 | `documents` | Answerable only via an exact token (`Section 15(2)`, `IMT-23`, `Rule 129A`, `DAP-3.2`). Where lexical/BM25 retrieval beats vectors. |
| `conceptual` | 8 | `documents` | Paraphrased, no identifier; semantics must carry it. Where vectors beat BM25. Several mirror an `exact_citation` item with the token stripped (e.g. q12 ↔ q01). |
| `near_duplicate` | 6 | `documents` | Answerable from one of the two package policies but not the other, where the surrounding text is near-identical. Includes the owner-driver PA aggregate (₹15 lakh Goods vs ₹2 lakh Commercial, q17/q18), both figures verified against the PDFs. |
| `internal_fact` | 8 | `documents` | A specific invented canon figure; proves retrieval rather than pretraining. |
| `sql` | 5 | `sql` | Answerable only from the operational tables. Covers a join (q31), a GROUP BY aggregate (q32), a window function (q33), a date range (q34) and an anti-join (q35). |
| `ambiguous_route` | 3 | `both` | Needs a document threshold **and** a database query. q36 combines the MTW Act weekly-hours limit with duty hours derived from trips; q37 combines the DAP-3.2 rest minimum with inter-trip gaps; q38 combines the PMS-4.1 service interval with per-vehicle odometer. |
| `refusal` | 2 | `refuse` | Plausible, in-domain, and genuinely absent from the corpus. The correct behaviour is to decline, not fabricate. |
| **Total** | **40** | | |

Route tally: `documents` 30, `sql` 5, `both` 3, `refuse` 2.

At least three questions are deliberately terse or underspecified, the way a depot
manager actually types (q20 "PA cover for owner driver on our pickups?", q27 "how far
under the mileage norm...", q29 "our own tyre limit before we pull the tyre off").

## Schema (one object per line)

```
id           qNN
question     depot-manager phrasing; never copies a distinctive sentence from the
             source, except that exact_citation questions contain the identifier verbatim
category     exact_citation | conceptual | near_duplicate | internal_fact | sql |
             ambiguous_route | refusal
route        documents | sql | both | refuse
gold_answer  the correct answer in one or two sentences
gold_source  [ { "document": "<path under data/>", "locator": "<clause or section id>" }, ... ]
gold_sql     SQL against the copilot.* views, or null
notes        what the item tests and why it is hard
```

`gold_source` paths are given relative to `data/`: bare filenames for the public PDFs
(e.g. `MotorVehiclesAct-1988.pdf`) and `internal/<file>.md` for the SOPs. `sql` and
`refusal` items carry an empty `gold_source`; `both` items carry both a document
locator and a `gold_sql`.

## How `gold_source` locators map to chunk ids after ingestion

The SOPs and statutes are chunked on their clause/section headings (the numbering was
written line-begin precisely so the splitter can anchor on it). After ingestion each
chunk carries a stable id of the form `<doc-slug>#<anchor>`. The `locator` in
`gold_source` is that `<anchor>`:

| Source type | Locator example | Expected chunk id (illustrative) |
|-------------|-----------------|----------------------------------|
| SOP clause | `DAP-3.2`, `PMS-7.1`, `ABR-2.1` | `driver-allowance-and-overnight-halt-policy#DAP-3.2` |
| MV Act section | `Section 134`, `Section 194(1)` | `motorvehiclesact-1988#s134` |
| MTW Act section | `Section 15(2)` | `motor-transport-workers-act#s15` |
| CMVR rule | `Rule 62`, `Rule 94`, `Rule 129A` | `cmvr-1989#r129a` |
| Add-ons endorsement | `IMT-23` | `motor-add-ons-for-commercial-vehicles#imt-23` |
| Package policy section | `Section IV`, `Section I(3)`, `Section I (CTL)` | `commercial-vehicle-package-policy#section-IV` |

Scoring convention: a document item is **retrieval-correct** when the retrieved chunk
set contains the chunk carrying the `gold_source` locator (all listed locators, for the
multi-source items q10/q19/q20/q21/q37). A `sql` item is scored on the query result /
routing, not on retrieved chunks. An `ambiguous_route` (`both`) item requires the
document chunk **and** a query; retrieving only one side is a partial failure. A
`refusal` item is correct only when the system declines; returning any fabricated figure
is a failure even if a near-miss chunk was retrieved.

Note that anchors are illustrative — reconcile the exact slug/anchor format with the
ingester's chunker once it lands, then keep this table in step.

## The `copilot.*` SQL views

The SQL slice is not built yet (`copilot/` is still the echo-only service). `gold_sql`
is written against the read-only, snake_case views that the SQL slice is expected to
expose — projections of the Prisma models in `server/prisma/schema.prisma`:

`copilot.vehicles` (registration_no, type, max_load_kg, odometer, region, status,
service_interval_km, last_service_odometer, …), `copilot.drivers` (id, name,
license_category, license_expiry, safety_score, status), `copilot.trips` (id, source,
destination, cargo_weight_kg, planned_distance, status, vehicle_id, driver_id,
customer_id, planned_start, planned_end, dispatched_at, completed_at, revenue,
fuel_consumed_l), `copilot.fuel_logs` (vehicle_id, trip_id, liters, cost, logged_at),
`copilot.expenses` (vehicle_id, trip_id, type, amount, incurred_at),
`copilot.maintenance_logs` (vehicle_id, description, cost, status, started_at,
closed_at), `copilot.customers` (id, name, rate_per_km, rate_per_tonne_km, flat_rate).

Adjust the view/column names in `gold_sql` if the SQL slice settles on different ones.
The seed conditions in `CANON.md` §9 ensure these queries return non-empty results.

## Never ingest

`CANON.md` and `eval_set.jsonl` (and this README) **must never enter the retrieval
corpus.** They are the answer key; ingesting them would let the model read the answers
it is being scored on. The guard is structural — this whole directory is
underscore-prefixed (`data/_eval/`) and the ingester scopes positively to
`data/internal/**/*.{pdf,md}` plus the public PDFs in `data/`, skipping any directory
whose name begins with `_` (see `copilot/README.md`). The `.gitkeep` and the banners at
the top of each file here are the second line of defence.
