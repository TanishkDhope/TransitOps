# The ingester

## 1. What this does

It reads the six reference PDFs in `data/` and the four internal Markdown SOPs in `data/internal/`, cuts them into passages, embeds each passage with Gemini, and writes the result to three tables in the `copilot` schema of the project's Neon database. It never reads `data/_eval/`, which holds the evaluation answer key. It does not retrieve anything, does not answer questions, and does not score anything — those belong to a later slice, and `/ask` in `../main.py` still returns `tool: "echo"`. Its other output is a report, printed at the end of every run, whose numbers exist to catch the failures that would otherwise surface much later as bad answers. Running it twice in a row produces the same database.

## 2. How to run it

From the repo root:

```bash
uv run --project copilot python -m copilot.ingest.ingest --reset
```

Or from `copilot/`, which is the same module by a shorter name — the imports are relative so both work:

```bash
uv run python -m ingest.ingest --dry-run                    # chunk + report, no API calls, no DB
uv run python -m ingest.ingest --only internal --dry-run    # one doc_type, the fast loop
uv run python -m ingest.ingest                              # embed and load, replacing per document
uv run python -m ingest.ingest --reset                      # truncate all three tables first
```

`--only` takes `statute`, `insurance` or `internal`. `--dry-run` is the loop you want while tuning a splitter: it opens no database connection and makes no embedding calls, so it costs nothing and finishes in about three minutes, almost all of it pdfplumber reading the 489-page CMVR. The CLI is defined in `ingest.py:895 § main`.

Two environment variables are required, both read from `copilot/.env` and nowhere else — `load_dotenv` at `ingest.py:51` points at that file explicitly. `require_env` (`ingest.py:56`) stops the run naming the missing key rather than failing later with a connection error.

| Variable | Used for | Copy from |
|---|---|---|
| `DATABASE_URL` | the Neon connection | `server/.env` |
| `GEMINI_API_KEY` | `gemini-embedding-001` | `server/.env` |

Both are documented in `copilot/.env.example`. Neither file is committed.

`--no-cache` ignores the local checkpoint and re-embeds everything. You want it only when the vectors themselves are suspect; a splitter change does not need it, because the checkpoint is keyed by content (§ 9).

**Cost of a first run.** 1,333 chunks, about 430,000 tokens, 21 requests at a batch size of 64 (`EMBED_BATCH`, `ingest.py:287`) — measured, not estimated. Wall clock about 3½ minutes, of which roughly 2½ is pdfplumber reading the 489-page CMVR and well under a minute is the embedding API. There is deliberately no pacing, no token bucket and no scheduler: the project's per-minute allowances are orders of magnitude above what one run needs, so a limiter would be code that never fires. Backoff handles a genuine transient (§ 7). A second run costs nothing — every vector is checkpointed.

## 3. Three tables, not one

The DDL is `schema.sql`. Read it alongside this section.

A row in `documents` is one file on disk. A row in `sections` is one logical passage of that file — a statute section, a policy SECTION or IMT endorsement, a numbered SOP clause, or one table. A row in `chunks` is one embedded window of a section, usually 300–400 tokens.

Sections and chunks are separate because they are used at different moments. A chunk is what a query is *matched* against, and matching works better when the unit is small and about one idea; a whole 900-token statute section dilutes into an average of everything it discusses and stops being near any particular question. A section is what a language model is later *given to read*, and reading works better when the unit is complete: the sentence that qualifies a rule is often two paragraphs away from the sentence that states it. Storing only chunks would give good matching and truncated answers. Storing only sections would give whole passages that nothing retrieves reliably. So the chunk carries the embedding and the section carries the text, and a later retrieval step matches on chunks and returns their parent sections.

```sql
CREATE TABLE IF NOT EXISTS copilot.documents (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         text NOT NULL,
  doc_type      text NOT NULL,          -- statute | insurance | internal; also the --only vocabulary
  issuer        text,                   -- see below; nullable, and a null is reported not swallowed
  source_path   text NOT NULL UNIQUE,   -- UNIQUE is what makes delete-then-insert per document work
  source_format text NOT NULL,          -- pdf | markdown
  page_count    integer,                -- NULL for markdown
  ingested_at   timestamptz NOT NULL DEFAULT now()
);
```

`issuer` is load-bearing rather than decorative. The corpus holds two motor package policies whose wording is about 80% identical but whose figures differ, so an answer that quotes a limit without naming the insurer is not a citation, it is a coin flip. The values are read out of the documents themselves by `detect_issuer` (`loaders.py:153`), which yields *Magma HDI Gerling General Insurance* for the Commercial policy and *Raheja QBE General Insurance Co* for the Goods Carrying policy. `KNOWN_INSURERS` (`loaders.py:117`) is a fallback used only if extraction stops finding them.

```sql
CREATE TABLE IF NOT EXISTS copilot.sections (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id  bigint NOT NULL REFERENCES copilot.documents(id) ON DELETE CASCADE,
  section_path text NOT NULL,           -- 'Chapter V — CONTROL OF TRANSPORT VEHICLES > Section 66. Necessity for permits'
  ordinal      integer NOT NULL,        -- position in the document, 0-based; the read order
  content      text NOT NULL,           -- raw text, NO breadcrumb
  page_from    integer,                 -- true PDF pages, tracked per line; NULL for markdown
  page_to      integer,
  UNIQUE (document_id, ordinal)
);
```

`section_path` is the human-readable address of the passage and the thing a citation is built from. It is not unique within a document: a table extracted from the middle of a clause is stored as its own section under a path derived from that clause, so two rows can share a path. `ordinal` is what makes a row unique and what preserves document order.

```sql
CREATE TABLE IF NOT EXISTS copilot.chunks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id  bigint NOT NULL REFERENCES copilot.sections(id) ON DELETE CASCADE,
  ordinal     integer NOT NULL,
  content     text NOT NULL,            -- WITH the breadcrumb; see § 6
  embedding   vector(768) NOT NULL,     -- L2-normalised; see § 7
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  content_sha text GENERATED ALWAYS AS (md5(lower(regexp_replace(content, '\s+', ' ', 'g')))) STORED,
  UNIQUE (section_id, ordinal)
);
```

`tsv` is a `tsvector`: Postgres's parsed, stemmed, position-annotated form of a document, which is what keyword search actually matches against. It is a generated column, which means Postgres computes it from `content` on write and it can never drift out of step with the text. That is the point — see § 6.

`content_sha` is a normalised hash used to find duplicates. Whitespace is collapsed and case folded first, so two copies of the same paragraph that differ only in line breaks still hash alike. `content_sha_py` (`ingest.py:204`) mirrors this expression in Python so that `--dry-run` can report duplicates with no database; the two must be changed together.

Everything lives in the `copilot` schema, created at `schema.sql:16`. Prisma owns `public` — `server/prisma/schema.prisma` declares no `@@schema`, so all ten of its models land there, and `prisma migrate dev` drops tables it does not recognise. A separate schema is what stops the two from ever meeting. `npx prisma migrate status` reports no drift after a load.

## 4. What happens to one PDF

Take `data/Commercial Vehicle Package Policy.pdf`.

1. **Discovery.** `discover` (`loaders.py:71`) expands two globs and nothing else: `data/*.pdf`, deliberately non-recursive, and `data/internal/**/*.md`, rooted below `internal/` (`loaders.py:62-63`). Neither can reach `data/_eval/`. `_skipped_dir` (`loaders.py:66`) additionally rejects any path with an underscore-prefixed directory component; that is a second lock on a door the globs cannot open.

2. **Classification.** `classify_pdf` (`loaders.py:135`) matches the file name against `PDF_SPECS`, giving the title, the `doc_type` (`insurance`), and which splitter to use. An unrecognised PDF is skipped with a message rather than guessed at.

3. **Reading.** `read_pdf` (`loaders.py:284`) walks the pages once. Before it starts, `_consensus_gutter` (`loaders.py:265`) decides whether the document is set in two columns, by looking for a vertical band near the middle of the page that almost no word crosses (`_gutter`, `loaders.py:237`). This policy is two-column, with a gutter at x≈292. It matters enormously: read naively, the left and right columns interleave line by line and the text becomes `SECTION II – LIABILITY TO THIRD PARTIES 4. The Company may at its own option`. The gutter is decided per document, not per page, because a page with a heading spanning both columns defeats per-page detection.

4. **Tables.** `_usable_tables` (`loaders.py:219`) takes pdfplumber's ruled-line table detection and discards the false positives — anything with fewer than two rows or columns, anything covering more than 92% of the page (that is a border, not a table), anything entirely empty. Each survivor is serialised to a Markdown pipe table by `_table_to_markdown` (`loaders.py:201`), with newlines inside cells collapsed to spaces. The table's glyphs are then filtered out of the page's prose (`loaders.py:284`) so the same text is not stored twice. `Page.raw` keeps the unfiltered text; `Page.text` is the prose.

5. **Back matter.** `ombudsman_start` (`loaders.py:391`) walks backwards from the last page and drops the Insurance Ombudsman and Insurance Council office tables — pages 19–20 here. See § 5 for why this is harder than it sounds.

6. **Splitting.** `to_lines` (`loaders.py:429`) flattens the kept pages into `(line, page number)` pairs, which is how page attribution survives. `split_insurance` (`loaders.py:596`) walks those lines and emits sections. `_attach_tables` (`loaders.py:805`) then inserts each table as its own atomic section, positioned after the prose section it fell inside.

7. **Chunking.** `build` (`ingest.py:847`) calls `chunk_section` (`ingest.py:174`) on each section and wraps every resulting body in its breadcrumb (§ 6). The strings it returns are the final `chunks.content` values — there is no second place where a chunk's text is constructed.

7b. **Input cap.** `enforce_input_cap` (`ingest.py:231`) splits any chunk over 2,000 tokens so the embedding API will accept it, logging each one. See § 7.

8. **Embedding.** `Embedder.embed` (`ingest.py:503`) deduplicates, checks the checkpoint by `content_sha`, and sends the misses in batches of 64. `_process` (`ingest.py:441`) handles one batch, retries what is retryable, and records rather than raises on what is not.

9. **Writing.** `write_document` (`ingest.py:573`) deletes any existing row for this `source_path` — which cascades to its sections and chunks — inserts the document, inserts all sections in one statement using `unnest` so their ids come back with their ordinals, and streams the chunks in with `COPY`. Vectors go over the wire as the text `[0.1,0.2,…]` (`vector_literal`, `ingest.py:551`) and pgvector parses them server-side, so no client adapter is needed.

10. **Indexes and report.** Search indexes are rebuilt (§ 8), the run is appended to `runs.jsonl` (§ 9), and the report prints (§ 10).

## 5. Chunking, per format

The size rules are shared. Target 400 tokens, hard ceiling 600, overlap 60 (`ingest.py:74-77`). Counting is `cl100k_base` via tiktoken (`encoder`, `ingest.py:80`) — not Gemini's own tokeniser, which is not available offline, but close enough on English legal prose, and the counts only place boundaries rather than respect a hard limit. If the encoding cannot be loaded the run stops rather than falling back to a character heuristic, because a silent fallback would move every boundary in the corpus.

A section under the ceiling is emitted whole. A section marked `atomic` is emitted whole whatever its size. Otherwise `chunk_section` (`ingest.py:174`) splits on blank lines, then re-splits only the pieces still over the ceiling on line-begin clause markers (`CLAUSE_LINE`, `ingest.py:109`), then on sentences (`SENTENCE`, `ingest.py:110`), then on raw token windows. `_pack` (`ingest.py:145`) fills chunks greedily to the target and carries a 60-token tail forward.

The cascade exists because PDF text has no blank lines. Paragraph splitting alone would return the whole section as one unit, so the clause-marker level is what actually does the work on statutes and policies.

### Statutes — MV Act, MTW Act, CMVR

The boundary is the section header, `STATUTE_SECTION` at `loaders.py:460`:

```python
re.compile(r"^\s*(\d+[A-Z]{0,2})\.\s+(.{5,140}?)\.?\s*—")
```

A statute section begins with its number, its title, and an em dash introducing the operative words: `66. Necessity for permits.—(1) No owner…`. Splitting here rather than every N characters keeps a section's number, its title and its text in one unit, which is precisely what a citation-shaped question ("what does section 66 require") needs to match. A fixed character count would routinely put the number in one chunk and the rule in the next, and neither would answer the question.

A long title wraps and leaves the em dash on the following line. `split_statute` (`loaders.py:483`) therefore retries the match on the two lines joined; without that, section 12 of the MV Act disappears into the body of section 11.

Chapter headings are tracked (`CHAPTER`, `loaders.py:455`) and prefixed into the path. Footnote apparatus is dropped by `to_lines` (`loaders.py:429`): a line matching `FOOTNOTE` (`loaders.py:424`) ends the usable text of *that page*, because the apparatus sits at the foot of the page. Truncating per page rather than per document means a stray match can never swallow the following page.

`STATE AMENDMENT` blocks are kept, not dropped, and split out under their own path with the jurisdiction named (`_jurisdiction`, `loaders.py:474`). That tag is the whole point: a Uttar Pradesh–only provision retrieved without it reads as central law.

**Contents pages are detected and dropped.** They are lists of bare section titles with no text beneath them, and left in the corpus they outrank real content on every citation query — each query word appears in the title line and nowhere else on the chunk — while carrying no information. `toc_end` (`loaders.py:348`) finds the heading (`TOC_HEADING`, `loaders.py:321`) and then drops pages while they still look like contents. Two independent signals are needed, because the three statutes differ: the MV Act's contents carry no page numbers, and the CMVR's list of forms carries no leading rule numbers. `_looks_like_toc` (`loaders.py:334`) accepts either a high density of numbered entries or a high density of lines ending in a page number, and rejects any page containing a real section header (`BODY_MARKER`, `loaders.py:331`). Detected, not hardcoded — the answers come out at pages 1–7, 1–2 and 1–18 respectively, and 1–18 is a range no one would have guessed.

**Worked example** — MV Act section 66, 870 tokens, split into 3:

```
--- Chapter V — CONTROL OF TRANSPORT VEHICLES > Section 66. Necessity for permits
--- pages 40-41  atomic=False  section_tokens=870  chunks=3

[chunk 0] 424 tokens
  [The Motor Vehicles Act, 1988 > Chapter V — CONTROL OF TRANSPORT VEHICLES > Section 66. Necessity for permits]

  66. Necessity for permits.—(1) No owner of a motor vehicle shall use or permit the use of the
  vehicle as a transport vehicle in any public place whether or not such vehicle is actually carrying any
  passengers or goods save in accordance with the conditions of a permit granted or countersigned by a
  Regional or State Transport Authority …
  Provided that a stage carriage permit shall, subject to any conditions that may be specified in the
  permit, authorise the use of the vehicle as a contract carriage:
  …

[chunk 1] 424 tokens
  [The Motor Vehicles Act, 1988 > Chapter V — CONTROL OF TRANSPORT VEHICLES > Section 66. Necessity for permits]

  (b) to any transport vehicle owned by a local authority or by a person acting under contract with a
  local authority and used solely for road cleansing, road watering or conservancy purposes;

  (c) to any transport vehicle used solely for police, fire brigade or ambulance purposes;
  …
```

The split falls between the operative sub-sections and the list of exemptions — a boundary the clause-marker splitter found, and one a character count would not have. Section 3, at 140 tokens, is under the ceiling and stays whole.

### Insurance policies

Three boundaries, in priority order in `split_insurance` (`loaders.py:596`): IMT endorsement markers (`IMT_HEADER`, `loaders.py:564`), roman-numbered policy sections (`POLICY_SECTION`, `loaders.py:560`), and all-caps headings (`ALLCAPS`, `loaders.py:566`).

The all-caps rule is an addition beyond what was specified, and it is necessary: these policies carry substantive blocks with no SECTION number at all — `GENERAL EXCEPTIONS`, `CONDITIONS`, `AVOIDANCE OF CERTAIN TERMS AND RIGHT OF RECOVERY`, `RULES APPLICABLE TO TANKERS CARRYING HAZARDOUS CHEMICALS`. Without it, SECTION IV swallows the entire back half of the document into one section. A `CONDITIONS` gate (`loaders.py:574`) additionally promotes the numbered conditions inside that block to their own sections, so "Condition 11 — No Claim Bonus" is individually addressable; the gate resets on the next SECTION or IMT header so that numbered provisos *inside* an endorsement are not fragmented.

Endorsements are marked `atomic` — never merged with a neighbour, never split internally. An IMT endorsement is a self-contained contractual clause; half of one is a sentence missing the words that qualify it.

`IMT_HEADER` requires the marker to be followed by an all-caps title. That is what keeps in-text cross references — "Endorsement IMT- 35 is hereby deemed to", "(Endt. IMT 43 is to" — from being read as new endorsements. All three boundary branches also absorb a wrapped heading line into the title. This is not cosmetic: `IMT.23`'s title wraps, and before that fix the endorsement closed immediately after its own header and its entire 318-token body was filed under the following heading. `IMT.23` is exactly the endorsement `data/internal/accident-and-breakdown-reporting-procedure.md` cites for Class C and D vehicles.

**Ombudsman office tables are dropped**, by `ombudsman_start` (`loaders.py:391`) scanning backwards from the last page. They are pages of city names, street addresses and mailboxes; they carry no policy terms, and they match on city names, so a question about a depot in Nashik retrieves an office address. Scanning backwards rather than forwards matters, because both policies also contain a grievance-redressal clause that names the Ombudsman and *is* real content. Counting mentions of "Ombudsman" does not separate the two — the Goods policy's clause says it seven times. What separates them is the number of distinct mailboxes on the page, and `_looks_like_office_list` (`loaders.py:372`) uses that. The margin is narrow; see § 11.

**Worked example** — IMT.23, atomic, 318 tokens, one chunk:

```
--- IMT.23 — COVER FOR LAMPS TYRES / TUBES MUDGUARDS BONNET / SIDE PARTS BUMPERS
    HEADLIGHTS AND PAINTWORK OF DAMAGED PORTION ONLY
--- pages 9-9  atomic=True  section_tokens=318  chunks=1

[chunk 0] 368 tokens
  [Commercial Vehicle Package Policy > IMT.23 — COVER FOR LAMPS TYRES / TUBES MUDGUARDS …]

  IMT.23. COVER FOR LAMPS TYRES / TUBES
  (For all Commercial Vehicles)
  In consideration of payment of an additional premium of
  Rs....…..*, notwithstanding anything to the contrary contained
  in the Policy it is hereby understood and agreed that subject
  to conditions (a) (b) and (c) hereunder loss of or damage
  (excluding theft under any circumstances) to lamps …
```

SECTION II of the same policy, at 860 tokens, is not atomic and splits into 3 chunks, the first break falling between the indemnity clause and the exclusions.

### Markdown SOPs

`split_markdown` (`loaders.py:736`) takes the `# H1` as the title, reads the issuer out of the `Issued by:` line, and splits on `## N. Heading` (`MD_H2`, `loaders.py:727`) and then on line-begin clause numbers (`MD_CLAUSE`, `loaders.py:718`):

```python
re.compile(r"^(\d+(?:\.\d+)*\.?(?:\([a-z]\))?|\([a-z]\)|\([ivx]+\))\s+\S")
```

A lettered or roman sub-clause keeps its numbered parent in the path, so a definition is addressed as `1. Definitions > 1.1 > (c)` rather than `1. Definitions > (c)`. The clause is the right boundary here because the corpus cites itself that way — the SOPs refer to "the ceiling in FCR-3.3" and "PMS-7.1" — so the retrieval unit and the citation unit are the same thing. A character count would produce units nothing in the corpus refers to.

Markdown tables are held whole and marked atomic regardless of size: split across chunks, the rows lose their header and stop meaning anything. `_md_issuer` (`loaders.py:727`) picks the company out of the `Issued by:` line by shape rather than position, because that line names a department, then the company, then a postal address, and wraps.

**Worked example** — a clause and a table from the same document:

```
--- 4. Fuel norms and variance > 4.1        (Fuel Card SOP)
--- atomic=False  section_tokens=36  chunks=1

[chunk 0] 60 tokens
  [Fuel Card and Reimbursement Standard Operating Procedure > 4. Fuel norms and variance > 4.1]

  4.1 Actual Consumption on every trip is computed at Trip Close from the recorded distance
  and the fuel drawn, and is compared with the Fuel Norm for the vehicle's class.

--- 2. Insurance mapping and its origin > 2.1   (ABR, the class/insurer table)
--- atomic=True  chunks=1

  [Accident and Breakdown Reporting Procedure > 2. Insurance mapping and its origin > 2.1]

  | Class | Applicable Policy | Insurer | Owner-driver personal-accident cover |
  |-------|-------------------|---------|--------------------------------------|
  | A | Goods Carrying Vehicle Package Policy | Raheja QBE General Insurance | as fixed under Section IV … |
  | C | Commercial Vehicle Package Policy | Magma HDI General Insurance | as fixed under Section IV … |
```

Clause-level chunks are small — the internal SOPs have a median around 72 tokens. That is a deliberate consequence of splitting where the documents cite themselves, and the section row still carries the fuller passage.

## 6. The breadcrumb

Every stored chunk is prefixed with its address:

```
[{document title} > {section_path}]

{chunk text}
```

So a chunk from the MV Act looks like this, exactly as stored:

```
[The Motor Vehicles Act, 1988 > Chapter II — LICENSING OF DRIVERS OF MOTOR VEHICLES > Section 3. Necessity for driving licence]

3. Necessity for driving licence.—(1) No person shall drive a motor vehicle in any public place
unless he holds an effective driving licence issued to him authorising him to drive the vehicle; …
```

It earns its place twice. It gives an isolated 400-token window the context it lost when it was cut out of its document, which improves the embedding. And it puts the document title and section number into the keyword index, so a query naming a section number can match on it.

**The invariant: the string that is embedded and the string the tsvector indexes must be byte-identical.** They are, because there is only one of them. `breadcrumb` (`ingest.py:190`) is called in exactly one place — `build` at `ingest.py:858` — and the string it returns is what `main` hands to the embedder (`ingest.py:944`) and what `write_document` writes to `chunks.content` (`ingest.py:604`). `tsv` is a generated column over `content`, so Postgres derives the keyword index from the same bytes on write. There is no second construction anywhere to drift.

If the two ever did diverge — say the breadcrumb were added at write time but not before embedding — nothing would error. Every row would insert, both indexes would build, every query would return results. The vector index would describe one corpus and the keyword index another, and a later rank fusion would combine two rankings computed over different texts. The result is not a crash but a quiet loss of quality that no test catches and that looks exactly like "retrieval is a bit disappointing".

Sections keep raw text with no breadcrumb (`schema.sql:36`). Only chunks carry it.

## 7. Embeddings

Model `gemini-embedding-001`, 768 dimensions, `task_type="RETRIEVAL_DOCUMENT"` (`ingest.py:220-221`, call at `ingest.py:325`).

The model's native output is 3,072 dimensions. 768 is a deliberate truncation: it is a quarter of the storage and a quarter of the distance computation per comparison, an HNSW index over it builds and probes considerably faster, and on retrieval benchmarks the quality difference from full width is small. For a corpus of ~1,300 chunks the recall cost is not the binding constraint; the 500 MB instance and the query latency budget are.

`task_type` tells the model which of two related embeddings to produce. `RETRIEVAL_DOCUMENT` is for text being stored; `RETRIEVAL_QUERY` is for the question asked against it. Questions and documents are different kinds of text — a question is short, interrogative and often uses different vocabulary from the passage that answers it — and the two task types map them into the same space such that a question lands near its answer rather than near other questions. The query side is not this script's job, but whatever performs retrieval later must use `RETRIEVAL_QUERY`, or every distance will be measured against the wrong projection.

**Normalisation.** `l2_normalise` (`ingest.py:318`) scales every vector to unit length before storage. This is required, not tidiness. The model uses Matryoshka representation learning, in which a shorter prefix of the full vector is itself a usable embedding — that is what makes `output_dimensionality=768` possible. But only the *full* 3,072-dimension output is unit length. Take a prefix of a unit vector and you get something shorter than unit length, by an amount that varies per vector. Cosine distance assumes unit vectors; pgvector's `<=>` operator does divide by the norms, but the HNSW index built with `vector_cosine_ops` is where the assumption bites, and any later arithmetic on the vectors — averaging, dot products as a similarity shortcut — is silently wrong without it. Normalising once at write time makes every downstream operation correct by construction.

**The input cap.** The model accepts at most 2,048 input tokens. The chunker caps chunks at 600 — except atomic ones, which it must emit whole however long they are, and a CMVR annexure table reached 2,264. `enforce_input_cap` (`ingest.py:231`) runs between chunking and embedding: any chunk over 2,000 tokens (`EMBED_SPLIT_THRESHOLD`, `ingest.py:304`) is split at a paragraph boundary into consecutive chunks of the same section, each re-wrapped in the same breadcrumb so the § 6 invariant still holds. Every split is logged with document, section path and original token count, and counted in the report.

The guard lives in the embedding step, not the splitter, because the cap is a property of the model rather than of the documents: change the embedding model and this number moves, while the splitter should not. And it splits rather than truncating deliberately — a truncated chunk is stored text that its own embedding does not describe, which surfaces later as unexplained bad retrieval instead of as an error.

**Batching and failure handling.** Batches of 64 (`EMBED_BATCH`, `ingest.py:287`). `_process` (`ingest.py:441`) handles one batch and **never raises for a transport problem** — one bad batch must not cost the twenty other requests already paid for. Failures are collected and listed in the report with status, batch index, chunk count, token count and the first document/section in the batch. Chunks whose batch failed are simply not written; `write_document` skips them and the report says how many.

The three cases are distinguished:

- **429 rate limited** — backoff and retry, up to five attempts.
- **400 bad request** — usually an oversize input that slipped the guard. The batch is halved once and each half retried, which isolates the offending chunk and still lands the rest; if a single chunk still fails, it is recorded and the run continues.
- **5xx transient** — backoff and retry, up to five attempts.

With one important exception, learned the hard way. **Not every 429 is a rate limit.** A spending cap returns the same status with a body that says so, and no amount of backoff will ever clear it — on the first cold re-run this cost 105 requests, five futile retries against each of 21 batches, before failing. `TERMINAL_429` (`ingest.py:311`) now matches those bodies and stops the run immediately with the API's own message. `CONSECUTIVE_FAILURE_LIMIT` (`ingest.py:315`) is a second net: three batches failing in a row stops the run, because at that point the fault is the account or the network, not the batch.

## 8. Indexes

Four, defined in `schema.sql` and managed by `main` (`ingest.py:895`).

- **`chunks_embedding_hnsw`** (`schema.sql:78`) — HNSW is an approximate nearest-neighbour index: it builds a navigable layered graph over the vectors and trades a little recall for a large amount of speed, since the exact answer requires comparing the query against every row. `m=16, ef_construction=64` are pgvector's usual defaults. `vector_cosine_ops` because the vectors are unit-length and compared with cosine distance.
- **`chunks_tsv_gin`** (`schema.sql:82`) — GIN over the generated tsvector. This is the keyword half.
- **`chunks_content_sha_idx`** (`schema.sql:85`) — supports duplicate detection and query-time dedupe.
- **`chunks_bm25`** (`schema.sql:95`) — conditional; see below.

**They are created after the bulk load, never before.** `main` drops all four (`ingest.py:967`, list at `ingest.py:539`) before writing and recreates them afterwards (`ingest.py:978`). Building an HNSW graph incrementally as rows arrive means re-walking and re-linking the graph for every insert; building it once over a finished table is far cheaper. The GIN index would likewise be maintained per row for no benefit, since nothing queries it mid-load. The two foreign-key btrees are not in that list and stay in place — they are cheap and `write_document`'s cascading delete uses them.

**Which keyword path this database took, measured on the load of 2026-09-04: tsvector + GIN.** `bm25_available` (`ingest.py:561`) found neither `pg_textsearch` nor `pg_search` installed. Worth noting, because it was not expected: this Neon server *does* list one of them in `pg_available_extensions`, so `CREATE EXTENSION` may be possible. Nobody has tried. Until someone does, keyword ranking is **`ts_rank_cd`, which is cover-density ranking and is not BM25**.

The difference in practice: BM25 weighs a term by how rare it is across the whole corpus and dampens the effect of repeating a term, so a rare term like "IMT.23" dominates a common one like "vehicle". `ts_rank_cd` weights by how tightly the query terms cluster together in the document and knows nothing about corpus-wide term frequency, so a chunk that repeats "vehicle" ten times can outrank one that mentions "IMT.23" once. On a corpus where the discriminating tokens are section numbers and endorsement codes, that is a real difference — expect keyword ranking to need help from the vector side, and do not describe it as BM25 anywhere. `ts_rank_cd` is never called BM25 in this codebase.

The `tsv` column is generated either way, so if BM25 becomes available later, adding the index needs no reload.

**Index behaviour, measured.** At this corpus size the planner chooses a sequential scan for a nearest-neighbour query — 1,334 rows is small enough that scanning them all is genuinely cheaper than walking the graph. That is not a fault, and it is not evidence the index is broken: with `enable_seqscan = off` the same query plans as `Index Scan using chunks_embedding_hnsw`, 0.6 ms against 5.2 ms for the scan. `verify` (`ingest.py:630`) reports both, for exactly this reason. Expect the planner to switch on its own as the corpus grows.

Measured sizes after the load: `copilot.chunks` 14 MB total (8 MB heap), of which the HNSW index is 5.3 MB and the GIN index 904 kB; `copilot.sections` 1.3 MB; the whole `copilot` schema 16 MB. That is the real footprint against the Neon quota, and it is what makes the "never UPDATE an embedding" rule in § 9 matter — the vectors are most of it.

## 9. Re-running safely

The script is meant to be run many times while splitters are tuned, and it is built so that costs nothing.

**Without `--reset`**, each document is replaced individually: `write_document` (`ingest.py:573`) deletes the row matching `source_path` — which cascades to that document's sections and chunks — and inserts fresh. That is why `source_path` is `UNIQUE`. Re-running produces identical counts.

**`--reset`** issues `TRUNCATE copilot.chunks, copilot.sections, copilot.documents RESTART IDENTITY CASCADE` (`ingest.py:961`). It truncates rather than updating rows in place, and embeddings are never `UPDATE`d. A dead tuple is the old version of a row that Postgres leaves behind after an update or delete, invisible to queries but still occupying pages until vacuum reclaims it. An `UPDATE` of an embedding therefore does not overwrite 3 KB of vector — it writes a second copy and leaves the first as garbage. Re-embedding the corpus in place a dozen times over an afternoon of tuning is the realistic way to fill a 500 MB instance with rows nobody can read. `TRUNCATE` reclaims the space immediately instead.

**The embedding checkpoint** is what makes re-running cheap in money as well as time. `Embedder` (`ingest.py:333`) keeps a JSONL file at `ingest/.cache/embeddings.jsonl`, one line per vector, keyed by **`content_sha`** — the same normalised hash the database generates for `chunks.content`. Lines are appended as each batch lands (`_append_cache`, `ingest.py:383`), so a run that dies halfway keeps everything it had already bought; `_load_cache` (`ingest.py:361`) skips a truncated final line rather than refusing to start.

Keying by content is what makes this survive a splitter change: chunks whose text did not move are still hits, and only genuinely new text is re-embedded. Changing the breadcrumb or the model invalidates entries by changing the key or the recorded model, so there is no cache to clear by hand. `--no-cache` forces a full re-embed. The file is about 12 MB for this corpus and the directory is gitignored.

One caution, learned by doing it: deleting this file throws away real money and, if the API is unavailable when you re-run, leaves the corpus unloadable. Do not delete it to force a clean run — use `--no-cache`, which re-embeds without discarding what you have.

**The run log** is `ingest/runs.jsonl`, appended one line per run by `log_run` (`ingest.py:873`). A line records the timestamp, the CLI flags, the chunker configuration (target, ceiling, overlap, tokeniser), the embedding model, dimensions, task type and normalisation, the API call and cache-hit counts, which index path was in effect, the three counts, and the elapsed time. It exists so that a retrieval result measured next month can be traced back to the configuration that produced the corpus it ran against — "was that before or after we widened the ceiling" is otherwise unanswerable.

## 10. Reading the report

Printed by `print_report` (`ingest.py:724`) at the end of every run, `--dry-run` included. Each number is there because it catches one specific failure.

| Line | What a bad value means |
|---|---|
| document / section / chunk counts | A document missing entirely means classification failed and it was skipped. A statute with a handful of sections means the header regex stopped matching. |
| token min / median / p95 / max | **A max far above the ceiling is the loudest signal in the report.** It means a section header regex failed to match and a whole chapter became one section, hence one oversized chunk. A median far below target means the splitter is fragmenting. |
| above the ceiling | Should be tables and IMT endorsements only, since those are the atomic units. Anything else in that list is a missed boundary. |
| sections with zero chunks | Content was dropped silently — a section was created and then produced nothing. Should always be 0. |
| chunks with no alphanumeric body | A chunk of punctuation or table rules. Tested *after* stripping the breadcrumb, since the breadcrumb always contains letters and would otherwise mask an empty body. |
| duplicate content_sha (stored text) | Same text under the same document and path twice — usually a splitter emitting a header block repeatedly. |
| identical bodies across documents | The cross-document duplicate check. A handful is expected. A large number means a splitter is emitting boilerplate as content. |
| chunks by doc_type / source_format | A zero here means an entire class of source silently failed. |
| documents with no issuer | A policy with a null issuer cannot be cited safely, because the two policies differ only in their figures. |
| per-document notes | The contents and ombudsman page ranges that were dropped. Eyeball these: they are where over-eager detection would silently delete real content. |

Two hashes are reported, and the distinction matters. `content_sha` is the generated column, over the stored text *including* the breadcrumb — that is what a query-time dedupe would use. Because the breadcrumb begins with the document title, the same paragraph in two different documents can never collide on it. So the report also hashes the chunk body alone, and that is the number that finds text duplicated across documents.

**The first real load against Neon, 2026-09-04.** Tail of the report, with the sections that only exist on a real run:

```
chunks hard-split for exceeding the 2048-token input cap: 2
  2264 tokens -> [2000, 320]
      The Central Motor Vehicles Rules, 1989 — Chapter V > Section 10. The vehicles meeting the above norms…
  2290 tokens -> [1620, 703]
      Commercial Vehicle Package Policy — IMT.45 — INDEMNITY TO HIRER - LIABILITY ONLY POLICY…

embedding
  model gemini-embedding-001, 768 dims, task_type RETRIEVAL_DOCUMENT, L2-normalised
  21 API request(s), 1333 chunks embedded
failed batches: 0

database verification (queried, not inferred):
  row counts        documents 10  sections 944  chunks 1334
  null embeddings   0
  vector norms      sample of 20: min 1.000000  max 1.000000   within 1e-3 of 1.0
  knn plan          ->  Seq Scan on chunks (actual time=0.027..5.187 rows=1334.00 loops=1)
                    with seqscan off: ->  Index Scan using chunks_embedding_hnsw (actual time=0.612..0.635 rows=5.00)
  index             chunks_embedding_hnsw      5344 kB
  index             chunks_tsv_gin             904 kB
  index             chunks_content_sha_idx     96 kB
  keyword search    tsvector + GIN, ranked with ts_rank_cd (cover density, NOT BM25)
                    pg_textsearch/pg_search installed: no; offered by this server: yes
  size              copilot.chunks     total     14 MB   heap   8056 kB
  size              copilot.sections   total   1280 kB   heap   1176 kB
  size              copilot schema total 16 MB
```

1,334 chunks is 1,332 from the chunker plus the 2 the input-cap guard split. Both oversize chunks were atomic units the chunker is required to emit whole — a CMVR annexure table and one long IMT endorsement — so the guard is doing exactly the job it exists for, and both are named rather than silently truncated.

**The chunking half of the same run**, which is also what `--dry-run` prints:

```
documents 10   sections 944   chunks 1332

tokens per chunk (stored text, breadcrumb included)
  min 27   median 312   p95 787   max 2290
  target 400, ceiling 600, overlap 60 (cl100k_base)
  above the ceiling: 108 (expected: tables and IMT endorsements)
      2290  Commercial Vehicle Package Policy — IMT.45 — INDEMNITY TO HIRER - LIABILITY ONLY POLICY …
      2264  The Central Motor Vehicles Rules, 1989 — Chapter V > Section 10. The vehicles meeting the above norms …
      1587  The Central Motor Vehicles Rules, 1989 — Chapter V > Section 10. The vehicles meeting the above norms …
      1472  The Central Motor Vehicles Rules, 1989 — Chapter V > Section 10. The vehicles meeting the above norms …
      1466  The Central Motor Vehicles Rules, 1989 — Chapter V > Section 10. The vehicles meeting the above norms …

sections with zero chunks: 0
chunks with no alphanumeric body: 0

duplicate content_sha groups (stored text): 1
  7cc6e37199  x2  The Central Motor Vehicles Rules, 1989
              Chapter V > Section 8. Insurance of the vehicle
identical chunk bodies across documents: 5 group(s)
  bab98e3a94  x2  Commercial Vehicle Package Policy, Goods Carrying Vehicle Package Policy
              SECTION III — TOWING DISABLED VEHICLES
  dfe3dcf524  x2  Commercial Vehicle Package Policy, Goods Carrying Vehicle Package Policy
              AVOIDANCE OF CERTAIN TERMS AND RIGHT OF RECOVERY
  a0abe7e858  x2  Commercial Vehicle Package Policy, Goods Carrying Vehicle Package Policy
              CONDITIONS
  1f657149df  x2  Commercial Vehicle Package Policy, Goods Carrying Vehicle Package Policy
              Condition 3
  5109001522  x2  Accident and Breakdown Reporting Procedure, Fuel Card and Reimbursement Standard Operating Procedure
              1. Definitions > 1.1

chunks by doc_type:    insurance=131  internal=131  statute=1070
chunks by source_format: markdown=131  pdf=1201

documents with no issuer: 1  -> Motor Add-ons for Commercial Vehicle Package Policy

per document:
  The Central Motor Vehicles Rules, 1989         statute     489p   427 sections    728 chunks
      note: dropped contents pages 1-18
  Commercial Vehicle Package Policy              insurance    20p    80 sections     86 chunks
      note: dropped ombudsman/council office pages 19-20 (including 1 near-empty trailing page(s))
  Goods Carrying Vehicle Package Policy          insurance    21p    32 sections     40 chunks
      note: dropped ombudsman/council office pages 19-21
  Motor Add-ons for Commercial Vehicle Package P insurance     4p     5 sections      5 chunks
      note: no ombudsman office pages detected
  The Motor Transport Workers Act, 1961          statute      14p    43 sections     48 chunks
      note: dropped contents pages 1-2
  The Motor Vehicles Act, 1988                   statute     111p   226 sections    294 chunks
      note: dropped contents pages 1-7
  Accident and Breakdown Reporting Procedure     internal       —    34 sections     34 chunks
  Driver Allowance and Overnight Halt Policy     internal       —    35 sections     35 chunks
  Fuel Card and Reimbursement Standard Operating internal       —    30 sections     30 chunks
  Preventive Maintenance Schedule                internal       —    32 sections     32 chunks
```

Reading it: the shape is healthy — no lost sections, no empty chunks, contents and office pages dropped at plausible ranges, and every `doc_type` present. The five cross-document duplicate groups are real duplication in the sources (the two policies share the towing, avoidance-of-terms and conditions wording; two SOPs open with the same definitions preamble) rather than a splitter fault. The one thing the report is telling you to look at is the max of 2,290 and the 108 chunks over the ceiling: the top five are the CMVR's annexure tables and one very long IMT endorsement, all atomic and therefore expected — but their breadcrumb reads `Chapter V > Section 10. The vehicles meeting the above norms shall use…`, which is not a real section title. That is the CMVR splitter latching onto a numbered line inside a schedule and treating it as a rule heading. See § 11.

## 11. Known limitations

**The CMVR splitter is the most fragile thing here, by a wide margin.** It is 489 pages of rules, forms, schedules and annexures, and the statute regex was designed for the flat structure of an Act. Inside the schedules it matches numbered lines that are not rule headings, producing section paths like `Chapter V > Section 10. The vehicles meeting the above norms shall use`. The chunk *text* is correct and the tables under it are correct; the breadcrumb is wrong, which means the address on a CMVR citation cannot be trusted the way an MV Act citation can. If CMVR answers come back citing implausible rule numbers, this is why. The fix is a CMVR-specific splitter that distinguishes rules from the forms and schedules rather than reusing the Act splitter — that is the first thing to do if CMVR retrieval matters.

**The Commercial policy's page-1 banner title is split by the column crop.** The document-level gutter is applied to every page, and page 1's full-width title crosses it, so the title arrives as two fragments (`COMMERCIAL VEHICLE INS` / `SURANCE POLICY - PACKAGE`). No content is lost — the letters are all present — but it produces one or two junk section paths at the front of that document. Handling full-width elements on an otherwise two-column page would fix it.

**The ombudsman-tail threshold is fit closely to this corpus.** `_looks_like_office_list` drops a trailing page when it carries five or more distinct mailboxes. On these two policies the pages to keep have 4 and 2, and the pages to drop have 5, 5, 6, 7 and 7. That is a one-mailbox margin against dropping the grievance-redressal clause, which is real content. A third policy from a different insurer could easily fall the wrong side of it. The run report always prints the dropped range for exactly this reason — check it when a new document is added.

**The add-ons document has no issuer.** `Motor Add-ons for Commercial Vehicle Package Policy` names no insurer anywhere in its four pages, so `issuer` is null and the report says so on every run. Its footer ties it to the Commercial Vehicle Package Policy and therefore to Magma HDI, but that is an inference, and inferring an insurer onto a document is precisely the failure mode `issuer` exists to prevent. It was left null deliberately.

**Footnote stripping is page-scoped and blunt.** The first line matching `FOOTNOTE` ends the usable text of that page (`loaders.py:429`). That is right for these India Code PDFs, where the apparatus sits at the page foot, but a document with a mid-page footnote would lose the rest of that page. The report's "sections with zero chunks" line would not catch it; a sharp drop in a document's chunk count is the signal.

**Internal SOP chunks are small** — a median around 72 tokens, because clause-level splitting is what matches how the corpus cites itself. If SOP retrieval turns out to return fragments that are individually true but too thin to answer with, the thing to change is not the chunker but the retrieval step: return the parent section rather than the chunk. The schema was built for exactly that.

**The embedding API is a single point of failure, and its errors lie about themselves.** A 429 from this API can mean throughput (retry) or a spending cap (retrying is futile). `TERMINAL_429` (`ingest.py:311`) distinguishes them by matching the message body, which is string-matching on someone else's prose and will need extending when a new account condition appears. The symptom to recognise: every batch failing identically and immediately. If that happens, read the message rather than assuming a rate limit.

**Nothing here is tested automatically.** Correctness is established by reading the report, which is why the report is as detailed as it is. A regression in a splitter shows up as a count that moved, and there is no assertion that will catch it for you.

**If retrieval quality disappoints, look in this order:** the token max and the over-ceiling list (a missed header is the most common and most damaging fault); the per-document notes (over-eager front/back-matter detection); whether the query side is using `RETRIEVAL_QUERY` (§ 7); and only then the chunk size parameters.

## Corpus

`data/_eval/` is excluded and must stay excluded. It holds `CANON.md` and `eval_set.jsonl` — the fact sheet and question set that later answers are scored against. Ingesting it would put the marking scheme in the corpus and make every subsequent measurement meaningless. The globs at `loaders.py:62-63` cannot reach it, and `_skipped_dir` (`loaders.py:66`) rejects underscore-prefixed directories as a second lock.

Counts below are from the `--dry-run` in § 10.

| File | doc_type | Issuer | Pages | Sections | Chunks | What it is |
|---|---|---|---|---|---|---|
| `data/MotorVehiclesAct-1988.pdf` | statute | Government of India | 111 | 226 | 294 | The primary Act governing motor vehicles, licensing, registration, permits and third-party liability. |
| `data/CMVR_1989.pdf` | statute | Government of India | 489 | 427 | 728 | The Central Motor Vehicles Rules made under that Act — construction, maintenance, forms and the hazardous-goods rules. |
| `data/Motor-Transport-Workers-Act.pdf` | statute | Government of India | 14 | 43 | 48 | Employment law for transport workers: registration of undertakings, hours, rest, welfare. Carries two state amendments. |
| `data/Commercial Vehicle Package Policy.pdf` | insurance | Magma HDI Gerling General Insurance | 20 | 80 | 86 | The package policy covering Class C and D vehicles, with the full IMT endorsement set including IMT.23. |
| `data/Goods Carrying Vehicle Package Policy.pdf` | insurance | Raheja QBE General Insurance Co | 21 | 32 | 40 | The package policy covering Class A and B vehicles. About 80% identical in wording to the above, different figures. |
| `data/Motor add-ons for commercial vehicles.pdf` | insurance | *(none — see § 11)* | 4 | 5 | 5 | Optional add-on covers (engine protection, consumables, key loss) sold alongside a commercial vehicle package policy. |
| `data/internal/accident-and-breakdown-reporting-procedure.md` | internal | Sahyadri Freight Carriers Private Limited | — | 34 | 34 | ABR: incident reporting, insurer intimation, recovery, spills, escalation. Maps vehicle class to policy and insurer. |
| `data/internal/driver-allowance-and-overnight-halt-policy.md` | internal | Sahyadri Freight Carriers Private Limited | — | 35 | 35 | DAP: driver grades, hours and rest, road and night-out allowances, overnight halt eligibility. |
| `data/internal/fuel-card-and-reimbursement-sop.md` | internal | Sahyadri Freight Carriers Private Limited | — | 30 | 30 | FCR: fuel card issue and limits, fuel norms and variance, overloading, reimbursement deadlines. |
| `data/internal/preventive-maintenance-schedule.md` | internal | Sahyadri Freight Carriers Private Limited | — | 32 | 32 | PMS: service intervals, pre-monsoon inspection, wear limits, condemnation and total loss. |
