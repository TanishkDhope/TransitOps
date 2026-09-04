// Copilot — knowledge + query assistant.
//
// The question goes through Express, which enforces auth + RBAC and proxies to
// a private service that retrieves policy/statute passages and synthesises an
// answer. This page renders the /ask contract: an answer whose inline [n]
// markers index into `citations`, plus the refusal, database-stub and
// service-unavailable outcomes, which are all correct results rather than
// failures. Route access is gated upstream by ProtectedRoute via the '/copilot'
// entry in ROLE_ACCESS; the capability check here mirrors the server so we
// never render a form the API would refuse.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { motion } from 'framer-motion';
import {
  Sparkles, Send, FileText, AlertTriangle, ChevronDown, Database, Info,
  ShieldAlert, SearchX, WifiOff, RefreshCw, Check, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { askCopilot, askCopilotStream, getCopilotStatus } from '../api/copilot.js';
import { useToast, describeError } from '../hooks/useToast.js';
import { useAuth } from '../contexts/AuthContext';
import PageHeader from '../components/shared/PageHeader';
import EmptyState from '../components/shared/EmptyState';

const QUESTION_MAX_LENGTH = 500;

// Shown in the empty state. Drawn from the corpus the retrieval side actually
// indexes (statute, insurance wordings, internal SOPs) plus the operational
// records the database tools read, so both halves are discoverable.
const EXAMPLE_QUESTIONS = [
  'What rest is a driver owed between shifts under Section 15(2) of the Motor Transport Workers Act?',
  'What does endorsement IMT-23 cover on a commercial vehicle?',
  "Why is this driver's safety score below 100, and what is dragging it down?",
];

/** How long a source card stays highlighted after its marker is activated. */
const HIGHLIGHT_MS = 2500;

/**
 * Splits an answer into text runs and [n] citation markers.
 * Markers are kept — never stripped — because an index with no matching source
 * is a hallucinated reference the user needs to see.
 */
function parseAnswer(text, citationCount) {
  const parts = [];
  const pattern = /\[(\d+)\]/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      parts.push({ type: 'text', value: text.slice(cursor, match.index) });
    }
    const index = Number(match[1]);
    parts.push({ type: 'cite', index, valid: index >= 1 && index <= citationCount });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor) });
  return parts;
}

/** Scores and distances are floats of varying magnitude; keep them comparable. */
function formatScore(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—';
}

/** A page-level notice. Matches the tone conventions used across the app. */
function Notice({ icon: Icon, tone, title, children }) {
  const tones = {
    warning: { border: 'border-[#E4A900]/30', bg: 'bg-[#E4A900]/10', icon: 'text-[#E4A900]' },
    danger: { border: 'border-[#E46E78]/30', bg: 'bg-[#E46E78]/10', icon: 'text-[#E46E78]' },
    info: { border: 'border-[#5B899E]/30', bg: 'bg-[#5B899E]/10', icon: 'text-[#5B899E]' },
  };
  const style = tones[tone] ?? tones.info;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn('flex items-start gap-3 rounded-xl border p-4', style.border, style.bg)}
    >
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', style.icon)} />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-foreground">{title}</p>
        <div className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{children}</div>
      </div>
    </motion.div>
  );
}

/** Disclosure header. No shared collapsible exists, so this is the local one. */
function DisclosureButton({ open, onToggle, controls, children }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm font-medium',
        'text-foreground transition-colors hover:bg-muted/60',
        'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
      )}
    >
      <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} />
      {children}
    </button>
  );
}

export default function Copilot() {
  const toast = useToast();
  const { can, user } = useAuth();
  const { register, handleSubmit, reset, watch, setValue } = useForm({
    defaultValues: { question: '' },
  });

  const [available, setAvailable] = useState(null); // null = still checking
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { question, data }
  const [requestError, setRequestError] = useState(null); // { kind, title, description }
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activeCitation, setActiveCitation] = useState(null);
  const [progressSteps, setProgressSteps] = useState([]);

  const sourceRefs = useRef({});
  const warningRef = useRef(null);
  const highlightTimer = useRef(null);

  const question = watch('question') ?? '';
  const allowed = can('copilot:query');

  const checkStatus = useCallback(async () => {
    try {
      const { data } = await getCopilotStatus();
      setAvailable(Boolean(data?.data?.available));
    } catch {
      // A status probe failure is treated the same as "unavailable"; the
      // request path itself surfaces real errors through the toast layer.
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    if (allowed) checkStatus();
  }, [allowed, checkStatus]);

  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  const runAsk = useCallback(
    async (q) => {
      const trimmed = q.trim();
      // One request at a time — a second would race the first into state.
      if (!trimmed || isSubmitting) return;

      setIsSubmitting(true);
      setRequestError(null);
      setSourcesOpen(false);
      setActiveCitation(null);
      setProgressSteps([]);

      try {
        const { data } = await askCopilotStream({
          question: trimmed,
          onProgress: (event) => {
            if (event.toast) {
              toast.warning(event.label, { duration: 5000 });
              return;
            }
            setProgressSteps((prev) => {
              // Mark previous steps as done, add the new one as active.
              const completed = prev.map((s) => ({ ...s, status: 'done' }));
              return [...completed, { step: event.step, label: event.label, status: 'active' }];
            });
          },
        });

        // Mark all steps as done when the result arrives.
        setProgressSteps((prev) => prev.map((s) => ({ ...s, status: 'done' })));

        setResult({ question: trimmed, data: data.data });
        toast.fromResponse(data, 'Answer ready');
        reset({ question: '' });
      } catch (err) {
        const described = describeError(err, 'Could not reach the copilot');
        const code = err?.response?.data?.code;
        const status = err?.response?.status;

        let kind = 'failed';
        if (code === 'INTEGRATION_DISABLED') kind = 'unavailable';
        else if (status === 403 || code === 'FORBIDDEN') kind = 'forbidden';
        else if (!err?.response) kind = 'unavailable';

        setRequestError({ kind, title: described.title, description: described.description });
        toast.apiError(err, 'Could not reach the copilot');
        if (kind === 'unavailable') checkStatus();
      } finally {
        setIsSubmitting(false);
      }
    },
    [checkStatus, isSubmitting, reset, toast]
  );

  const onSubmit = ({ question: q }) => runAsk(q);

  const onExampleClick = (q) => {
    setValue('question', q);
    runAsk(q);
  };

  /** Opening the sources, then scrolling, has to wait for the panel to exist. */
  const focusCitation = useCallback((index) => {
    setSourcesOpen(true);
    setActiveCitation(index);

    requestAnimationFrame(() => {
      const el = sourceRefs.current[index];
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setActiveCitation(null), HIGHLIGHT_MS);
  }, []);

  const focusWarning = useCallback(() => {
    const el = warningRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // ---- 6. Forbidden -------------------------------------------------------
  // Mirrors the server's capability table. ProtectedRoute already bounces roles
  // without the route, so this catches a capability/route mismatch.
  if (!allowed) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Copilot"
          subtitle="Ask questions about your operations in plain language"
        />
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <EmptyState
            icon={ShieldAlert}
            title="Page not available for your role"
            description={`${user?.roleLabel ?? 'Your role'} does not have access to the copilot.`}
          />
        </div>
      </div>
    );
  }

  const data = result?.data;
  const citations = data?.citations ?? [];
  const invalidCitations = data?.invalid_citations ?? [];
  const isRefused = Boolean(data?.refused) || data?.route === 'refused';
  const usedDatabase = data?.route === 'database' || data?.route === 'mixed';
  const usedDocuments = data?.route === 'documents' || data?.route === 'mixed';
  const showAnswer = Boolean(data) && !isRefused;

  const serviceDown = available === false;
  const formDisabled = serviceDown || isSubmitting;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Copilot"
        subtitle="Ask questions about your operations in plain language"
      />

      {/* ---- 5a. Service unavailable (status probe) ------------------------ */}
      {serviceDown && (
        <Notice icon={WifiOff} tone="warning" title="Copilot is currently unavailable">
          <p>
            The assistant is not configured or is offline right now. The rest of TransitOps works
            normally — please try again later.
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={checkStatus}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Check again
          </Button>
        </Notice>
      )}

      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        onSubmit={handleSubmit(onSubmit)}
        className="rounded-xl border border-border bg-card p-5 shadow-sm"
      >
        <label htmlFor="question" className="mb-2 block text-sm font-medium text-foreground">
          Your question
        </label>
        <textarea
          id="question"
          rows={4}
          maxLength={QUESTION_MAX_LENGTH}
          disabled={formDisabled}
          placeholder="e.g. What rest is a driver owed between two shifts?"
          className={cn(
            'placeholder:text-muted-foreground dark:bg-input/30 border-input flex w-full min-w-0 resize-y rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]'
          )}
          {...register('question', { required: true })}
        />

        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground/70">
            {question.length}/{QUESTION_MAX_LENGTH}
          </span>
          <Button
            type="submit"
            disabled={formDisabled || question.trim().length === 0}
            className="bg-[#714B67] text-white hover:bg-[#5A3C52]"
          >
            {isSubmitting ? (
              'Asking…'
            ) : (
              <>
                <Send className="mr-2 h-4 w-4" />
                Ask Copilot
              </>
            )}
          </Button>
        </div>
      </motion.form>

      {/* ---- 5b/6. Request error ------------------------------------------- */}
      {requestError && (
        <Notice
          icon={
            requestError.kind === 'unavailable'
              ? WifiOff
              : requestError.kind === 'forbidden'
                ? ShieldAlert
                : AlertTriangle
          }
          tone={requestError.kind === 'failed' ? 'danger' : 'warning'}
          title={
            requestError.kind === 'forbidden'
              ? "You don't have access"
              : requestError.kind === 'unavailable'
                ? 'Copilot is unavailable'
                : requestError.title
          }
        >
          {requestError.kind === 'forbidden'
            ? (requestError.description ??
              `${user?.roleLabel ?? 'Your role'} does not have access to the copilot.`)
            : requestError.kind === 'unavailable'
              ? (requestError.description ??
                'The copilot service did not respond, so your question was not answered. Nothing else in TransitOps is affected.')
              : (requestError.description ??
                'The request could not be completed. Edit the question and try again.')}
        </Notice>
      )}

      {/* ---- 1. Loading ----------------------------------------------------- */}
      {isSubmitting && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          role="status"
          aria-live="polite"
          className="rounded-xl border border-border bg-card p-5 shadow-sm"
        >
          {progressSteps.length === 0 ? (
            <div className="flex items-center justify-center gap-3 py-10">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-[#714B67]" />
              <span className="text-sm text-muted-foreground">
                Connecting…
              </span>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                Progress
              </p>
              {progressSteps.map((s, i) => (
                <motion.div
                  key={`${s.step}-${i}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5"
                >
                  {s.status === 'done' ? (
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
                      <Check className="h-3 w-3 text-emerald-600" />
                    </div>
                  ) : (
                    <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[#714B67]" />
                  )}
                  <span
                    className={cn(
                      'text-sm',
                      s.status === 'done'
                        ? 'text-muted-foreground'
                        : 'font-medium text-foreground'
                    )}
                  >
                    {s.label}
                  </span>
                </motion.div>
              ))}
            </div>
          )}
        </motion.div>
      )}

      {/* ---- 7. Empty ------------------------------------------------------- */}
      {!isSubmitting && !result && !requestError && (
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <EmptyState
            icon={Sparkles}
            title="Ask about a rule, a policy, or your own records"
            description="Copilot answers from your internal SOPs, Indian transport statutes and commercial vehicle insurance wordings, citing the passage it used — and from your operational records for questions about drivers, trips, costs and incidents. Try one of these:"
            action={
              <div className="flex w-full max-w-2xl flex-col gap-2">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => onExampleClick(q)}
                    disabled={formDisabled}
                    className={cn(
                      'rounded-lg border border-border bg-background px-3 py-2 text-left text-sm',
                      'text-muted-foreground transition-colors hover:border-[#714B67]/40 hover:text-foreground',
                      'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      'disabled:pointer-events-none disabled:opacity-50'
                    )}
                  >
                    {q}
                  </button>
                ))}
              </div>
            }
          />
        </div>
      )}

      {/* ---- Result --------------------------------------------------------- */}
      {!isSubmitting && data && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
        >
          {/* The question stays with its answer so the pairing is unambiguous. */}
          <div className="border-b border-border/50 pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                You asked
              </p>
              {/* Which source answered — operational records read differently
                  from policy text, and the reader should know which they got. */}
              {usedDatabase && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  <Database className="h-3 w-3" />
                  {usedDocuments ? 'Records + documents' : 'Operational records'}
                </span>
              )}
            </div>
            <p className="mt-1 break-words text-sm font-medium text-foreground">{result.question}</p>
          </div>

          {/* ---- 3. Refused — a correct outcome, not an error ---------------- */}
          {isRefused && (
            <Notice icon={SearchX} tone="info" title="No relevant source found">
              {data.answer ||
                'Nothing in the indexed documents was close enough to this question to answer it. Try naming the document, rule or section you have in mind.'}
            </Notice>
          )}

          {/* ---- 2. Answered ------------------------------------------------- */}
          {showAnswer && (
            <>
              {invalidCitations.length > 0 && (
                <div
                  ref={warningRef}
                  tabIndex={-1}
                  className={cn(
                    'flex items-start gap-2 rounded-lg border border-[#E4A900]/30 bg-[#E4A900]/10 p-3 text-sm',
                    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                  )}
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#E4A900]" />
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Some references could not be verified.
                    </span>{' '}
                    {invalidCitations.map((n) => `[${n}]`).join(', ')}{' '}
                    {invalidCitations.length === 1 ? 'does' : 'do'} not match any retrieved source.
                    Treat the claims they support with caution.
                  </p>
                </div>
              )}

              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#714B67]/10">
                  <Sparkles className="h-4 w-4 text-[#714B67]" />
                </div>
                {/* Capped so a long answer never pushes the sources off-screen. */}
                <div className="max-h-[55vh] min-w-0 flex-1 overflow-y-auto pr-1">
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                    {parseAnswer(data.answer ?? '', citations.length).map((part, i) =>
                      part.type === 'text' ? (
                        <span key={i}>{part.value}</span>
                      ) : part.valid ? (
                        <button
                          key={i}
                          type="button"
                          onClick={() => focusCitation(part.index)}
                          aria-label={`Source ${part.index}: ${
                            citations[part.index - 1]?.document ?? 'source'
                          }`}
                          className={cn(
                            'mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded px-1 align-baseline',
                            'bg-[#714B67]/10 text-[11px] font-semibold text-[#714B67]',
                            'transition-colors hover:bg-[#714B67]/20',
                            'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                          )}
                        >
                          {part.index}
                        </button>
                      ) : (
                        <button
                          key={i}
                          type="button"
                          onClick={focusWarning}
                          title="This reference does not match any retrieved source"
                          aria-label={`Unverified reference ${part.index} — no matching source`}
                          className={cn(
                            'mx-0.5 inline-flex h-5 items-center justify-center gap-0.5 rounded px-1 align-baseline',
                            'border border-dashed border-[#E46E78]/50 bg-[#E46E78]/10 text-[11px] font-semibold text-[#E46E78]',
                            'transition-colors hover:bg-[#E46E78]/20',
                            'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                          )}
                        >
                          <AlertTriangle className="h-3 w-3" />
                          {part.index}
                        </button>
                      )
                    )}
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ---- Sources — collapsed by default ------------------------------ */}
          {citations.length > 0 && (
            <div className="border-t border-border/50 pt-3">
              <DisclosureButton
                open={sourcesOpen}
                onToggle={() => setSourcesOpen((v) => !v)}
                controls="copilot-sources"
              >
                Sources ({citations.length})
              </DisclosureButton>

              <div id="copilot-sources" hidden={!sourcesOpen} className="mt-3 space-y-2">
                {citations.map((citation, idx) => {
                  const n = idx + 1;
                  return (
                    <div
                      key={`${citation.document}-${citation.section_path}-${n}`}
                      ref={(el) => {
                        sourceRefs.current[n] = el;
                      }}
                      tabIndex={-1}
                      className={cn(
                        'flex gap-3 rounded-lg border border-border bg-background p-3',
                        'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        activeCitation === n &&
                          'ring-2 ring-[#714B67] ring-offset-2 ring-offset-card'
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-[#714B67]/10 px-1 text-[11px] font-semibold text-[#714B67]"
                      >
                        {n}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                          <span className="text-sm font-medium text-foreground">
                            {citation.document}
                          </span>
                          {/* Two wordings in this corpus are near-identical but
                              come from different insurers with different figures,
                              so the issuer is never optional — it is what tells
                              them apart. */}
                          {citation.issuer ? (
                            <Badge variant="secondary" className="font-normal">
                              {citation.issuer}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="font-normal text-muted-foreground">
                              Issuer not recorded
                            </Badge>
                          )}
                        </div>

                        <p
                          title={citation.section_path}
                          className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground"
                        >
                          {citation.section_path}
                        </p>

                        <p className="mt-1 text-xs text-muted-foreground/70">
                          Relevance score {formatScore(citation.score)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ---- Details — developer information, off by default ------------- */}
          <div className="border-t border-border/50 pt-3">
            <DisclosureButton
              open={detailsOpen}
              onToggle={() => setDetailsOpen((v) => !v)}
              controls="copilot-details"
            >
              Details
            </DisclosureButton>

            <div id="copilot-details" hidden={!detailsOpen} className="mt-3 space-y-3">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                {[
                  ['Route', data.route ?? '—'],
                  ['Retrieval mode', data.retrieval_mode ?? '—'],
                  ['Model', data.model ?? '—'],
                  ['Latency', typeof data.latency_ms === 'number' ? `${data.latency_ms} ms` : '—'],
                  ['Top-1 distance', formatScore(data.top1_distance)],
                  ['Top-1 rerank score', formatScore(data.top1_rerank_score)],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex justify-between gap-3 border-b border-border/40 pb-1"
                  >
                    <dt className="text-muted-foreground/70">{label}</dt>
                    <dd className="break-words text-right font-medium text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>

              {/* Fixed, parameterised lookups — there is no generated SQL to show,
                  so this is the calls that ran and what they returned. */}
              {Array.isArray(data.sql) && data.sql.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground/70">Tools called</p>
                  <ul className="space-y-1">
                    {data.sql.map((call, index) => (
                      <li
                        key={`${call.tool}-${index}`}
                        className="overflow-x-auto rounded border border-border/40 bg-muted/30 px-2 py-1 font-mono text-[11px] text-foreground"
                      >
                        {call.tool}
                        {call.args && Object.keys(call.args).length > 0 && (
                          <span className="text-muted-foreground">
                            {' '}
                            {JSON.stringify(call.args)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {Array.isArray(data.rows) && data.rows.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground/70">
                    Records returned
                  </p>
                  <pre className="max-h-64 overflow-auto rounded border border-border/40 bg-muted/30 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                    {JSON.stringify(data.rows, null, 2)}
                  </pre>
                </div>
              )}

              {data.multi_tool_requested && (
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                  The model asked for more than one tool in a single step. All of them ran and every
                  result fed into the answer.
                </p>
              )}
            </div>
          </div>
        </motion.section>
      )}
    </div>
  );
}
