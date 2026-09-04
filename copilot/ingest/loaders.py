"""Corpus loaders for the copilot retrieval ingester.

One splitter per source format. Everything in this module is pure: files go in,
`Section` objects come out. No database, no network, no embedding — `ingest.py`
does all of that.

A `Section` is a logical unit of a document (a statute section, a policy SECTION
or IMT endorsement, a numbered SOP clause, one table). It is the passage a
language model is later handed to read. `ingest.py` cuts each section into the
smaller windows that actually get embedded.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from pathlib import Path

import pdfplumber

# --------------------------------------------------------------------------
# Data
# --------------------------------------------------------------------------


@dataclass
class Section:
    section_path: str
    content: str
    page_from: int | None = None
    page_to: int | None = None
    # atomic sections are emitted as exactly one chunk however long they are:
    # tables lose their meaning when cut in half, and an IMT endorsement is a
    # self-contained contractual clause that must be retrieved whole.
    atomic: bool = False


@dataclass
class SourceDoc:
    source_path: str          # repo-relative, POSIX separators
    path: Path
    title: str
    doc_type: str             # statute | insurance | internal
    source_format: str        # pdf | markdown
    issuer: str | None
    page_count: int | None
    sections: list[Section] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)   # surfaced in the run report


# --------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------

# Positive globs only. `data/**` would sweep in data/_eval/, which holds the
# evaluation answer key (CANON.md, eval_set.jsonl); ingesting it would let the
# copilot read the marking scheme and invalidate every later measurement.
# data/*.pdf is deliberately non-recursive and data/internal/**/*.md is rooted
# at internal/, so neither glob can reach _eval. `_skipped_dir` below is the
# second line of defence, not the first.
PDF_GLOB = "data/*.pdf"
MD_GLOB = "data/internal/**/*.md"


def _skipped_dir(rel: Path) -> bool:
    """True for any path with an underscore-prefixed directory component."""
    return any(part.startswith("_") for part in rel.parts[:-1])


def discover(repo_root: Path) -> list[Path]:
    found: list[Path] = []
    for pattern in (PDF_GLOB, MD_GLOB):
        for path in sorted(repo_root.glob(pattern)):
            rel = path.relative_to(repo_root)
            if _skipped_dir(rel):
                continue
            found.append(path)
    return found


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class SourceSpec:
    pattern: str          # regex matched against the file name
    title: str
    doc_type: str
    splitter: str         # statute | insurance
    issuer: str | None    # None -> detect from the document text


PDF_SPECS: list[SourceSpec] = [
    SourceSpec(r"MotorVehiclesAct-1988", "The Motor Vehicles Act, 1988",
               "statute", "statute", "Government of India"),
    SourceSpec(r"Motor-Transport-Workers-Act", "The Motor Transport Workers Act, 1961",
               "statute", "statute", "Government of India"),
    SourceSpec(r"CMVR", "The Central Motor Vehicles Rules, 1989",
               "statute", "statute", "Government of India"),
    SourceSpec(r"Goods Carrying Vehicle Package Policy", "Goods Carrying Vehicle Package Policy",
               "insurance", "insurance", None),
    SourceSpec(r"Commercial Vehicle Package Policy", "Commercial Vehicle Package Policy",
               "insurance", "insurance", None),
    SourceSpec(r"Motor add-ons for commercial vehicles",
               "Motor Add-ons for Commercial Vehicle Package Policy",
               "insurance", "insurance", None),
]

# Fallback only. The insurer is read out of the document text first; this map
# exists so a text-extraction regression cannot silently produce a NULL issuer
# on the two documents where the insurer is load-bearing. The two policies are
# ~80% identical wording with different figures, so an answer that cites one
# without naming the insurer is wrong.
KNOWN_INSURERS = {
    "Goods Carrying Vehicle Package Policy": "Raheja QBE General Insurance Company Limited",
    "Commercial Vehicle Package Policy": "Magma HDI Gerling General Insurance",
}

# Deliberately case-sensitive on the company-name part. The policies say
# "...has applied to MAGMA HDI GERLING GENERAL INSURANCE"; matched
# case-insensitively, the leading lowercase words come along for the ride and
# the issuer is stored as "Has Applied To Magma Hdi...".
INSURER_PAT = re.compile(
    r"[A-Z][A-Za-z&.'\-]*(?:\s+[A-Z][A-Za-z&.'\-]*){0,5}"
    r"\s+(?:GENERAL\s+INSURANCE|General\s+Insurance)"
    r"(?:\s+(?:CO\.?|COMPANY|Co\.?|Company))?(?:\s+(?:LTD\.?|LIMITED|Ltd\.?|Limited))?"
)

INSURER_STOPWORDS = re.compile(r"(?i)^(?:any|other|such|the|no|this|of|and|body|council|to)\b")


def classify_pdf(path: Path) -> SourceSpec | None:
    for spec in PDF_SPECS:
        if re.search(spec.pattern, path.name, re.I):
            return spec
    return None


def doc_type_of(path: Path) -> str | None:
    """The doc_type a file will get, decided from its name alone.

    Lets --only skip a document without opening it.
    """
    if path.suffix.lower() == ".md":
        return "internal"
    spec = classify_pdf(path)
    return spec.doc_type if spec else None


def detect_issuer(page_texts: list[str]) -> str | None:
    """Most frequent insurer-shaped string in the document."""
    counts: dict[str, int] = {}
    for text in page_texts:
        for raw in INSURER_PAT.findall(text):
            name = re.sub(r"\s+", " ", raw).strip(" .,")
            # "any other insurance covering", "Governing Body of Insurance
            # Council" and similar prose match loosely; drop anything that
            # starts with a stop word rather than a company name.
            if INSURER_STOPWORDS.match(name):
                continue
            counts[name.upper()] = counts.get(name.upper(), 0) + 1
    if not counts:
        return None
    best = max(counts.items(), key=lambda kv: (kv[1], len(kv[0])))[0]
    return " ".join(_recase(w) for w in best.split())


# Insurer names are printed in full capitals, which reads badly in a citation.
# Title-casing them blindly turns HDI into Hdi, so short acronyms are left alone.
NOT_ACRONYMS = {"CO", "CO.", "LTD", "LTD.", "THE", "AND", "OF"}


def _recase(word: str) -> str:
    if word.upper() == word and 2 <= len(word) <= 4 and word not in NOT_ACRONYMS:
        return word
    return word.capitalize()


# --------------------------------------------------------------------------
# PDF text extraction
# --------------------------------------------------------------------------


@dataclass
class Page:
    number: int              # 1-based
    text: str                # prose, with table regions removed
    raw: str                 # everything on the page, tables included
    tables: list[str]        # markdown-serialised, in reading order


def _in_boxes(obj, boxes) -> bool:
    cx = (obj["x0"] + obj["x1"]) / 2
    cy = (obj["top"] + obj["bottom"]) / 2
    return any(x0 <= cx <= x1 and top <= cy <= bottom for x0, top, x1, bottom in boxes)


def _table_to_markdown(rows) -> str:
    """Serialise an extracted table as a markdown pipe table.

    Newlines inside a cell are collapsed to spaces: a cell that spans two
    printed lines is still one value, and leaving the break in makes the row
    unparseable and the chunk noisy.
    """
    clean = [[re.sub(r"\s+", " ", (c or "")).replace("|", r"\|").strip() for c in row]
             for row in rows]
    width = max(len(r) for r in clean)
    clean = [r + [""] * (width - len(r)) for r in clean]
    head, *body = clean
    out = ["| " + " | ".join(head) + " |",
           "| " + " | ".join("---" for _ in head) + " |"]
    out += ["| " + " | ".join(r) + " |" for r in body]
    return "\n".join(out)


def _usable_tables(page):
    """Tables worth extracting, with page-frame false positives dropped."""
    keep = []
    page_area = float(page.width) * float(page.height)
    for table in page.find_tables():
        rows = table.extract()
        if len(rows) < 2 or max((len(r) for r in rows), default=0) < 2:
            continue
        x0, top, x1, bottom = table.bbox
        if page_area and (x1 - x0) * (bottom - top) / page_area > 0.92:
            # A ruled border around the whole page is not a table.
            continue
        if not any(any((c or "").strip() for c in row) for row in rows):
            continue
        keep.append((table.bbox, rows))
    return keep


def _gutter(page) -> float | None:
    """x of a clear vertical gutter for a two-column page, else None.

    The Commercial Vehicle policy is set in two columns; read naively, its
    left- and right-hand columns interleave line by line and the text becomes
    unusable. Detection is by finding a vertical band in the middle of the page
    that almost no word crosses.
    """
    words = page.extract_words()
    if len(words) < 40:
        return None
    x0_page, x1_page = float(page.bbox[0]), float(page.bbox[2])
    span = x1_page - x0_page
    best = None
    for step in range(38, 63):
        x = x0_page + span * step / 100
        crossing = sum(1 for w in words if w["x0"] < x < w["x1"])
        if crossing > len(words) * 0.01:
            continue
        left = sum(1 for w in words if w["x1"] <= x)
        right = len(words) - left
        if min(left, right) < len(words) * 0.25:
            continue
        if best is None or min(left, right) > best[1]:
            best = (x, min(left, right))
    return None if best is None else best[0]


def _consensus_gutter(pages) -> float | None:
    """One gutter for the whole document.

    Per-page detection misses pages where a heading or a wide table straddles
    the middle. If a quarter of the pages agree on a gutter, the same x is used
    for every page of that document.
    """
    found = [g for g in (_gutter(p) for p in pages) if g is not None]
    if len(found) < max(2, len(pages) * 0.25):
        return None
    return statistics.median(found)


def _normalise(text: str) -> str:
    text = text.replace(" ", " ").replace("﻿", "")
    text = re.sub(r"[ \t]+", " ", text)
    return "\n".join(line.rstrip() for line in text.split("\n"))


def read_pdf(path: Path) -> list[Page]:
    out: list[Page] = []
    with pdfplumber.open(path) as pdf:
        gutter = _consensus_gutter(pdf.pages)
        for n, page in enumerate(pdf.pages, start=1):
            tables = _usable_tables(page)
            base = page
            if tables:
                boxes = [bbox for bbox, _ in tables]
                # Remove table glyphs from the prose so the same text is not
                # stored twice, once as a table chunk and once as loose lines.
                base = page.filter(lambda obj, _b=boxes: not _in_boxes(obj, _b))
            x0, top, x1, bottom = page.bbox

            def read(target):
                if gutter is None or not (x0 < gutter < x1):
                    return target.extract_text() or ""
                left = target.crop((x0, top, gutter, bottom)).extract_text() or ""
                right = target.crop((gutter, top, x1, bottom)).extract_text() or ""
                return (left.strip() + "\n" + right.strip()).strip()

            # `raw` keeps the table text. Contents pages are often ruled, so
            # they are extracted as tables and vanish from `text`; front- and
            # back-matter detection has to look at the page as printed.
            out.append(Page(number=n, text=_normalise(read(base)), raw=_normalise(read(page)),
                            tables=[_table_to_markdown(rows) for _, rows in tables]))
    return out


# --------------------------------------------------------------------------
# Front-matter and back-matter detection
# --------------------------------------------------------------------------

# "ARRANGEMENT OF SECTIONS" (MV Act, MTW Act) or a "Rule CONTENTS Page" header
# (CMVR). Detected, never hardcoded to a page range: the three statutes put
# their tables of contents in different places and at very different lengths
# (7 pages, 1 page and 27 pages respectively).
TOC_HEADING = re.compile(
    r"ARRANGEMENT\s+OF\s+(?:SECTIONS|RULES)|^\s*(?:Rule|Section)\s+CONTENTS\b", re.I | re.M)
TOC_ENTRY = re.compile(r"^\s*\d+[A-Z]{0,2}\.\s+\S")
TOC_NOISE = re.compile(r"^\s*(?:[A-Z][A-Z0-9 ,.\-()&/']{1,89}|\d{1,4}|_+)\s*$")
# A contents line that ends in the page number it points at. The MV Act's
# contents pages carry no page numbers and the CMVR's list of forms carries no
# leading rule numbers, so neither signal alone covers all three statutes.
TOC_TAIL = re.compile(r"\S\s+\d{1,4}\s*$")
# A real section header carries a body after an em dash. Contents pages carry
# only the bare title, so this is what separates the two.
BODY_MARKER = re.compile(r"\d+[A-Z]{0,2}\.\s+.{5,140}?\.?\s*—")


def _looks_like_toc(text: str) -> bool:
    lines = [ln for ln in text.split("\n") if ln.strip()]
    if not lines:
        return True                      # a blank page inside the contents block
    if BODY_MARKER.search(text):
        return False
    entries = sum(1 for ln in lines if TOC_ENTRY.match(ln))
    noise = sum(1 for ln in lines if not TOC_ENTRY.match(ln) and TOC_NOISE.match(ln))
    tails = sum(1 for ln in lines if TOC_TAIL.search(ln))
    numbered = entries >= 3 and (entries + noise) / len(lines) >= 0.45
    paginated = len(lines) >= 8 and tails / len(lines) >= 0.5
    return numbered or paginated


def toc_end(pages) -> tuple[int, str]:
    """Index of the first body page, and a note for the report.

    Contents pages are bare section titles with no text under them. Left in the
    corpus they outrank real content on any citation-shaped query — every query
    word appears in the title line and nowhere else on the chunk — while
    carrying no information at all.
    """
    start = next((i for i, p in enumerate(pages) if TOC_HEADING.search(p.raw)), None)
    if start is None:
        return 0, "no table of contents detected"
    i = start
    cap = start + max(1, int(len(pages) * 0.30))     # never eat a third of a document
    while i < len(pages) and i < cap and _looks_like_toc(pages[i].raw):
        i += 1
    if i <= start:
        return 0, "no table of contents detected"
    return i, f"dropped contents pages {pages[start].number}-{pages[i - 1].number}"


EMAIL = re.compile(r"[\w.\-]+@[\w.\-]+")
TAIL_MARKER = re.compile(r"(?i)OMBUDSM[AE]N|INSURANCE\s+COUNCIL|COUNCIL\s+OF\s+INSURERS")


def _looks_like_office_list(text: str) -> bool:
    """An address table, not a clause that happens to mention the Ombudsman.

    Both policies carry a grievance-redressal clause naming the Ombudsman, and
    that clause is real policy content. Counting mentions of "Ombudsman" does
    not separate the two — the Goods policy's clause names it seven times. What
    does separate them is the number of distinct mailboxes: an office table
    lists one per office, a clause gives one or two escalation addresses. On
    this corpus the pages to keep carry 4 and 2, the pages to drop carry 5 to 7.
    That is a narrow margin; the run report always prints the page range this
    drops, so a regression here is visible rather than silent.
    """
    if not text.strip() or not TAIL_MARKER.search(text):
        return False
    emails = len(set(m.lower() for m in EMAIL.findall(text)))
    pins = len(set(re.findall(r"\b\d{6}\b", text)))
    return emails >= 5 or pins >= 3


def ombudsman_start(pages) -> tuple[int, str]:
    """Index just past the last body page of a policy, and a note.

    Policies end with pages of Insurance Ombudsman and Insurance Council office
    addresses. They contain no policy terms and they match on city names, so a
    question about a depot in Nashik or Pune retrieves an office address. The
    run is taken backwards from the end so the grievance-redressal clause in
    the body, which also mentions the Ombudsman, is left alone.
    """
    end = len(pages)
    # A page carrying nothing but a stray email address left over from the
    # table above it would otherwise stop the scan before it starts.
    while end > 0 and len(pages[end - 1].raw.strip()) < 200:
        end -= 1
    orphans = len(pages) - end
    dropped = 0
    while end > 0 and _looks_like_office_list(pages[end - 1].raw):
        end -= 1
        dropped += 1
    if dropped == 0:
        return len(pages), "no ombudsman office pages detected"
    if end < len(pages) * 0.5:                        # implausible; keep everything
        return len(pages), "ombudsman detection rejected (would drop over half the document)"
    note = f"dropped ombudsman/council office pages {pages[end].number}-{pages[-1].number}"
    if orphans:
        note += f" (including {orphans} near-empty trailing page(s))"
    return end, note


# --------------------------------------------------------------------------
# Line model
# --------------------------------------------------------------------------

FOOTNOTE = re.compile(
    r"^\s*\d+\.\s+(Subs(?:tituted)?|Ins(?:erted)?|Omitted|The words|Vide|"
    r"Renumbered|Added|Certain words|Now see|Cl\.|Earlier)\b", re.M)


def to_lines(pages, strip_footnotes: bool = False) -> list:
    """Flatten pages to (line, page number) pairs.

    Footnote apparatus sits at the foot of a page, so the first footnote line
    on a page ends the usable text of that page. Truncating per page rather
    than per document means a stray match can never swallow the next page.
    """
    lines = []
    for page in pages:
        for ln in page.text.split("\n"):
            if strip_footnotes and FOOTNOTE.match(ln):
                break
            lines.append((ln, page.number))
    return lines


def _flush(acc):
    body = "\n".join(ln for ln, _ in acc).strip()
    pages = [p for _, p in acc]
    return body, (min(pages) if pages else None), (max(pages) if pages else None)


# --------------------------------------------------------------------------
# Splitter: statutes (MV Act, MTW Act, CMVR)
# --------------------------------------------------------------------------

CHAPTER = re.compile(r"^\s*CHAPTER\s+([IVXLCDM]+)\s*$", re.I)
# A statute section begins with its number, its title, and an em dash
# introducing the operative text. Splitting here rather than on a character
# count keeps a section's number, title and text in the same unit, which is
# exactly what a citation-shaped question needs to match.
STATUTE_SECTION = re.compile(r"^\s*(\d+[A-Z]{0,2})\.\s+(.{5,140}?)\.?\s*—")
STATE_AMENDMENT = re.compile(r"^\s*\[?\s*STATE\s+AMENDMENTS?\b", re.I)

STATES = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat",
    "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh",
    "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Orissa", "Punjab",
    "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
    "Uttaranchal", "West Bengal", "Andaman and Nicobar", "Chandigarh", "Dadra and Nagar Haveli",
    "Daman and Diu", "Delhi", "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
    "Pondicherry",
]


def _jurisdiction(lines, i: int) -> str | None:
    """State named on or just after a STATE AMENDMENT heading."""
    window = " ".join(ln for ln, _ in lines[i:i + 3])
    for state in STATES:
        if re.search(r"\b" + re.escape(state) + r"\b", window, re.I):
            return state
    return None


def split_statute(lines):
    sections: list[Section] = []
    notes: list[str] = []
    state = {"chapter": None, "path": "Front matter", "base": "Front matter"}
    acc = []
    untagged = 0

    def close():
        body, pf, pt = _flush(acc)
        if body:
            sections.append(Section(state["path"], body, pf, pt))
        acc.clear()

    i = 0
    while i < len(lines):
        line, page = lines[i]

        m = CHAPTER.match(line)
        if m:
            title = next((t for t, _ in lines[i + 1:i + 3] if t.strip()), "")
            chapter = "Chapter " + m.group(1).upper()
            if title and title.isupper() and not STATUTE_SECTION.match(title):
                chapter = chapter + " — " + title.strip()
                i += 1
            state["chapter"] = chapter
            i += 1
            continue

        if STATE_AMENDMENT.match(line):
            close()
            juris = _jurisdiction(lines, i)
            if juris is None:
                untagged += 1
            # Tagging the jurisdiction into the path is what stops a state-only
            # provision being retrieved later as if it were central law.
            state["path"] = "{} > STATE AMENDMENT ({})".format(
                state["base"], juris or "jurisdiction not identified")
            acc.append((line, page))
            i += 1
            continue

        m = STATUTE_SECTION.match(line)
        consumed = 0
        if not m and i + 1 < len(lines):
            # A long section title wraps, leaving the em dash on the next line.
            # Section 12 of the MV Act does this; without the two-line attempt
            # it disappears into the body of section 11.
            joined = line.rstrip() + " " + lines[i + 1][0].strip()
            m = STATUTE_SECTION.match(joined)
            if m:
                consumed = 1
        if m:
            close()
            base = "Section {}. {}".format(m.group(1), m.group(2).strip())
            if state["chapter"]:
                base = state["chapter"] + " > " + base
            state["base"] = base
            state["path"] = base
            acc.append((line, page))
            for k in range(consumed):
                acc.append(lines[i + 1 + k])
            i += 1 + consumed
            continue

        acc.append((line, page))
        i += 1

    close()
    if untagged:
        notes.append(f"{untagged} STATE AMENDMENT block(s) with no jurisdiction identified")
    return sections, notes


# --------------------------------------------------------------------------
# Splitter: insurance policies
# --------------------------------------------------------------------------

POLICY_SECTION = re.compile(r"^\s*SECTION\s+([IVX]+)\b\s*[-–—:]?\s*(.*)$")
# IMT.23, IMT.11.A, IMT.37A — an endorsement marker followed by its all-caps
# title. Requiring the title is what keeps in-text cross references
# ("Endorsement IMT- 35 is hereby deemed") from being read as new endorsements.
IMT_HEADER = re.compile(
    r"^\s*IMT[.\s\-]*(\d+[A-Z]?(?:\.[A-Z])?)\.?\s+([A-Z][A-Z0-9 /,.&()'’\-]{4,})\s*$")
ALLCAPS = re.compile(r"^[A-Z0-9][A-Z0-9 ,.\-()&/‘’]{7,89}$")

# Gate marker: the CONDITIONS heading begins the numbered-conditions block.
# GENERAL EXCEPTIONS is excluded — its numbered items (1-6) are exception
# descriptions, not condition headings.  The gate persists through other
# all-caps headings (e.g. RULES APPLICABLE TO TANKERS) because in the Goods
# policy conditions 11-16 appear *after* that block.  It is reset only by
# SECTION [IVX]+ or IMT.NN headers.
CONDITION_GATE = re.compile(r"^CONDITIONS$")
# A numbered condition heading: "1. Notice shall...", "6 The Company...",
# "11.No Claim Bonus", "1. a..Premium".  The lookahead for a letter (upper
# or lower) avoids matching "1.50%" and dates like "12-9-2001".  The
# conditions gate already prevents false positives on sub-clauses in
# earlier sections.
CONDITION_HEADING = re.compile(r"^\s*(\d{1,2})\.?\s*(?=[A-Za-z])")


def _is_heading(line: str) -> bool:
    line = line.strip()
    if not ALLCAPS.match(line):
        return False
    letters = [c for c in line if c.isalpha()]
    # Multi-word headings: ≥6 letters and ≥2 words (GENERAL EXCEPTIONS, etc.)
    # Single-word headings: ≥8 letters (CONDITIONS, DEDUCTIBLES).  A shorter
    # threshold would match noise like "THE" or page-header fragments.
    if len(line.split()) >= 2:
        return len(letters) >= 6
    return len(letters) >= 8


def split_insurance(lines):
    """Split on SECTION headers, IMT endorsement markers and all-caps headings.

    The spec asks for SECTION and IMT boundaries only. All-caps headings are
    added because these policies carry substantive blocks with no SECTION
    number at all — GENERAL EXCEPTIONS, CONDITIONS, RULES APPLICABLE TO TANKERS
    CARRYING HAZARDOUS CHEMICALS — and without them SECTION IV would swallow
    the whole back half of the document into a single section.

    Numbered conditions (1. through 16.) inside the CONDITIONS block are split
    into their own sections so that "Condition 11 — No Claim Bonus" is
    individually retrievable.  The gate activates when a CONDITIONS / GENERAL
    EXCEPTIONS / DEDUCTIBLES heading is seen and deactivates on the next
    SECTION [IVX]+ or IMT.NN header, preventing IMT endorsement sub-numbering
    from being fragmented.
    """
    sections: list[Section] = []
    state = {"path": "Front matter", "atomic": False}
    # in_conditions_block: when True, bare "N." lines become section headings.
    # Activated by a CONDITIONS / GENERAL EXCEPTIONS / DEDUCTIBLES all-caps
    # heading.  Reset by any SECTION [IVX]+ or IMT.NN header so that numbered
    # provisos inside endorsements are not mistakenly promoted to sections.
    in_conditions_block = False
    acc = []

    def close():
        body, pf, pt = _flush(acc)
        if body:
            sections.append(Section(state["path"], body, pf, pt, state["atomic"]))
        acc.clear()

    i = 0
    while i < len(lines):
        line, page = lines[i]
        stripped = line.strip()

        m = IMT_HEADER.match(line)
        if m:
            close()
            title = m.group(2).strip()
            j = i
            # An endorsement title that wrapped is still one title. Without
            # this the second line reads as a fresh all-caps heading, the
            # endorsement closes immediately after its own header, and its
            # entire body is filed under the wrong section. IMT.23 in the
            # Commercial policy does exactly this.
            while j + 1 < len(lines) and _is_heading(lines[j + 1][0]):
                j += 1
                title = (title + " " + lines[j][0].strip()).strip()
            state["path"] = "IMT.{} \u2014 {}".format(m.group(1), title)
            # Endorsements are self-contained: never merged with a neighbour,
            # never split internally.
            state["atomic"] = True
            in_conditions_block = False          # gate reset
            acc.append((line, page))
            i = j + 1
            continue

        m = POLICY_SECTION.match(line)
        if m:
            close()
            title = m.group(2).strip()
            j = i
            # "SECTION I - LOSS OF OR DAMAGE TO THE" / "VEHICLE INSURED" is one
            # heading that wrapped, not a heading followed by another one.
            while j + 1 < len(lines) and _is_heading(lines[j + 1][0]):
                j += 1
                title = (title + " " + lines[j][0].strip()).strip()
            state["path"] = "SECTION " + m.group(1) + (" \u2014 " + title if title else "")
            state["atomic"] = False
            in_conditions_block = False          # gate reset
            acc.append((line, page))
            i = j + 1
            continue

        if _is_heading(stripped):
            close()
            title = stripped
            j = i
            # A heading that wrapped onto a second line is still one heading.
            while j + 1 < len(lines) and _is_heading(lines[j + 1][0]):
                j += 1
                title = title + " " + lines[j][0].strip()
            state["path"] = title
            state["atomic"] = False
            # Activate the conditions gate when the heading is a known gate
            # marker.  This is what makes "1. Notice shall..." split into
            # "Condition 1" rather than being swallowed by the heading above.
            if CONDITION_GATE.match(title):
                in_conditions_block = True
            acc.append((title, page))
            i = j + 1
            continue

        # --- Numbered condition headings (gate-controlled) ----------------
        # Only fire inside a CONDITIONS / GENERAL EXCEPTIONS / DEDUCTIBLES
        # block, so that "1." sub-clauses inside SECTION I-IV (depreciation
        # schedule, perils list) are not promoted to headings.
        if in_conditions_block:
            m = CONDITION_HEADING.match(stripped)
            if m:
                close()
                state["path"] = "Condition {}".format(m.group(1))
                state["atomic"] = False
                acc.append((line, page))
                i += 1
                continue

        acc.append((line, page))
        i += 1

    close()
    return sections, []


# --------------------------------------------------------------------------
# Splitter: markdown SOPs
# --------------------------------------------------------------------------

MD_H1 = re.compile(r"^#\s+(.*)$")
MD_H2 = re.compile(r"^##\s+(.*)$")
# Line-begin clause numbers: 3.4, 7.1.2, 2.(a), (b), (iv).
MD_CLAUSE = re.compile(r"^(\d+(?:\.\d+)*\.?(?:\([a-z]\))?|\([a-z]\)|\([ivx]+\))\s+\S")
# The "Issued by:" line names a department, then the company, then a postal
# address, and wraps across lines. Only the company is worth storing as the
# issuer, so it is picked out by shape rather than by position.
MD_ISSUER = re.compile(r"^Issued by:\s*(.+(?:\n(?!\w+:).*)?)", re.M)
COMPANY = re.compile(r"([A-Z][A-Za-z&.'\-]*(?:\s+[A-Z][A-Za-z&.'\-]*)*\s+"
                     r"(?:Private\s+Limited|Pvt\.?\s+Ltd\.?|Limited|Ltd\.?))")


def _md_issuer(text: str) -> str | None:
    m = MD_ISSUER.search(text)
    if not m:
        return None
    line = re.sub(r"\s+", " ", m.group(1)).strip()
    company = COMPANY.search(line)
    return company.group(1).strip() if company else line.split(",")[0].strip()


def split_markdown(text: str):
    """Return (title, issuer, sections) for an internal SOP."""
    lines = text.split("\n")
    heads = [MD_H1.match(ln) for ln in lines]
    title = next((m.group(1).strip() for m in heads if m), "Untitled")
    issuer = _md_issuer(text)

    sections: list[Section] = []
    state = {"heading": "Preamble", "clause": None, "sub": None}
    acc: list[str] = []
    in_table = False

    def path() -> str:
        parts = [state["heading"], state["clause"], state["sub"]]
        return " > ".join(p for p in parts if p)

    def close(atomic: bool = False):
        body = "\n".join(acc).strip()
        if body:
            sections.append(Section(path(), body, None, None, atomic))
        acc.clear()

    for ln in lines:
        if MD_H1.match(ln):
            continue
        row = ln.strip().startswith("|")
        if row and not in_table:
            # A markdown table is kept whole however long it is: split across
            # chunks, the rows lose their header and stop meaning anything.
            close()
            in_table = True
        elif in_table and not row:
            close(atomic=True)
            in_table = False

        if not in_table:
            m = MD_H2.match(ln)
            if m:
                close()
                state["heading"] = m.group(1).strip()
                state["clause"] = None
                state["sub"] = None
                continue

            m = MD_CLAUSE.match(ln)
            if m:
                close()
                marker = m.group(1).rstrip(".")
                # A lettered or roman sub-clause hangs off the numbered clause
                # above it, so the path keeps both: "1. Definitions > 1.1 > (c)"
                # is citable, "1. Definitions > (c)" is not.
                if marker[0].isdigit():
                    state["clause"], state["sub"] = marker, None
                else:
                    state["sub"] = marker
                acc.append(ln)
                continue

        acc.append(ln)

    close(atomic=in_table)
    return title, issuer, sections


# --------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------


def _attach_tables(sections, pages):
    """Insert each extracted table as its own atomic section, in reading order.

    The host is always looked up among the prose sections, never among the
    tables already inserted; otherwise the second table on a page hangs off the
    first and the paths nest ("… > Table 1 (p. 1) > Table 1 (p. 2) > …").
    """
    inserts: dict[int, list[Section]] = {}
    for page in pages:
        host = -1
        for idx, sec in enumerate(sections):
            if sec.page_from is not None and sec.page_from <= page.number:
                host = idx
        for n, table in enumerate(page.tables, start=1):
            label = "Table {} (p. {})".format(n, page.number)
            path = label if host < 0 else "{} > {}".format(sections[host].section_path, label)
            inserts.setdefault(host, []).append(
                Section(path, table, page.number, page.number, atomic=True))

    out = list(inserts.get(-1, []))
    for idx, sec in enumerate(sections):
        out.append(sec)
        out.extend(inserts.get(idx, []))
    return out


def load(path: Path, repo_root: Path) -> SourceDoc | None:
    rel = path.relative_to(repo_root).as_posix()

    if path.suffix.lower() == ".md":
        text = path.read_text(encoding="utf-8")
        title, issuer, sections = split_markdown(text)
        return SourceDoc(rel, path, title, "internal", "markdown", issuer, None, sections)

    spec = classify_pdf(path)
    if spec is None:
        return None

    pages = read_pdf(path)
    page_count = len(pages)
    notes: list[str] = []

    if spec.splitter == "statute":
        start, note = toc_end(pages)
        notes.append(note)
        body_pages = pages[start:]
        sections, split_notes = split_statute(to_lines(body_pages, strip_footnotes=True))
    else:
        end, note = ombudsman_start(pages)
        notes.append(note)
        body_pages = pages[:end]
        sections, split_notes = split_insurance(to_lines(body_pages))

    notes += split_notes
    sections = _attach_tables(sections, body_pages)

    issuer = spec.issuer or detect_issuer([p.raw for p in body_pages])
    if issuer is None:
        issuer = KNOWN_INSURERS.get(spec.title)
        if issuer:
            notes.append("issuer not found in text; used the known-insurer fallback")

    return SourceDoc(rel, path, spec.title, spec.doc_type, "pdf", issuer, page_count,
                     sections, notes)
