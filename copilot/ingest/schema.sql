-- Retrieval corpus DDL for the TransitOps copilot.
--
-- Everything lives in the `copilot` schema, never in `public`. Prisma owns
-- `public` (server/prisma/schema.prisma has no @@schema, so all of its models
-- land there) and `prisma migrate dev` drops tables it does not know about.
-- A separate schema is what keeps the two from colliding.
--
-- The file is split into three sections by the `-- @section:` markers below.
-- ingest.py reads them separately and applies them at different points in a
-- run: `base` up front, `indexes` only after the bulk load, `bm25` after that
-- and only if the extension is present.

-- @section: base

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS copilot;

-- One row per source file on disk.
CREATE TABLE IF NOT EXISTS copilot.documents (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         text NOT NULL,
  doc_type      text NOT NULL,          -- statute | insurance | internal
  issuer        text,                   -- insurer / issuing authority; load-bearing for citation:
                                        -- the two package policies are ~80% identical text with
                                        -- different figures, so the answer must name the insurer
  source_path   text NOT NULL UNIQUE,   -- repo-relative, POSIX separators.
                                        -- UNIQUE is what makes delete-then-insert per document work
  source_format text NOT NULL,          -- pdf | markdown
  page_count    integer,                -- NULL for markdown
  ingested_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per logical section of a document: a statute section, a policy
-- SECTION or IMT endorsement, a numbered SOP clause. This is the unit a
-- language model is later handed to read. It is NOT embedded.
CREATE TABLE IF NOT EXISTS copilot.sections (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id  bigint NOT NULL REFERENCES copilot.documents(id) ON DELETE CASCADE,
  section_path text NOT NULL,           -- e.g. 'Chapter V > Section 66. Necessity for permits'
  ordinal      integer NOT NULL,        -- position within the document, 0-based
  content      text NOT NULL,           -- raw section text, NO breadcrumb
  page_from    integer,
  page_to      integer,
  UNIQUE (document_id, ordinal)
);

-- One row per embedded window of a section. This is the unit matched against.
-- `content` carries the breadcrumb prefix; see ingest.py § breadcrumb().
CREATE TABLE IF NOT EXISTS copilot.chunks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id  bigint NOT NULL REFERENCES copilot.sections(id) ON DELETE CASCADE,
  ordinal     integer NOT NULL,         -- position within the section, 0-based
  content     text NOT NULL,            -- '[title > section_path]\n\n<text>' -- the exact string
                                        -- that was embedded, so the vector index and the keyword
                                        -- index below cover identical text
  embedding   vector(768) NOT NULL,     -- gemini-embedding-001 truncated to 768 dims, L2-normalised
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  -- Normalised hash used to find duplicate text across documents. Kept in step
  -- with content_sha_py() in ingest.py, which must produce the same value.
  content_sha text GENERATED ALWAYS AS (md5(lower(regexp_replace(content, '\s+', ' ', 'g')))) STORED,
  UNIQUE (section_id, ordinal)
);

-- Foreign-key support indexes. Unlike the search indexes these are cheap and
-- stay in place across runs.
CREATE INDEX IF NOT EXISTS sections_document_id_idx ON copilot.sections (document_id);
CREATE INDEX IF NOT EXISTS chunks_section_id_idx    ON copilot.chunks (section_id);

-- @section: indexes

-- Built AFTER the bulk load. Building an HNSW graph incrementally as rows
-- arrive is far slower than building it once over a full table, and the GIN
-- index would otherwise be maintained on every inserted row for no benefit.
-- ingest.py drops all three before loading and recreates them here.

-- HNSW: approximate nearest-neighbour index over the embeddings. vector_cosine_ops
-- because the vectors are L2-normalised and matched by cosine distance (<=>).
CREATE INDEX chunks_embedding_hnsw ON copilot.chunks
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- GIN over the generated tsvector: the keyword half of the retrieval.
CREATE INDEX chunks_tsv_gin ON copilot.chunks USING gin (tsv);

-- Duplicate detection and dedupe at query time.
CREATE INDEX chunks_content_sha_idx ON copilot.chunks (content_sha);

-- @section: bm25

-- Created only when pg_textsearch (or pg_search) is already installed; ingest.py
-- probes pg_extension first. pg_textsearch needs shared_preload_libraries and
-- PostgreSQL 17/18, so it is usually unavailable on managed Postgres, Neon
-- included. When it is missing the corpus falls back to the tsvector/GIN index
-- above ranked with ts_rank_cd. The tsv column is generated either way, so
-- switching between the two paths later needs no reload.
CREATE INDEX chunks_bm25 ON copilot.chunks USING bm25 (content) WITH (text_config = 'english');
