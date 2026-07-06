import { handleMailSearch } from './mail-search.js';
import { handleMailGet } from './mail-get.js';
import { handleMailGetThread } from './mail-get-thread.js';
import { handleLlmSummarize } from './llm-summarize.js';
import { getSummaryPolicy } from '../summarization/policy.js';

interface MailSummaryInput {
  query?: string;
  mode?: 'auto' | 'snippet_only' | 'selective_dive';
  maxEmails?: number;
  filters?: {
    startUtc?: number;
    endUtc?: number;
    fromEmail?: string;
    mailbox?: string;
    hasAttachments?: boolean;
    isRead?: boolean;
    category?: string;
    excludeMailboxes?: string[];
    excludeCategories?: string[];
  };
}

interface SearchRow {
  mailId: number;
  dateUtc: number;
  subject: string;
  from: string;
  mailbox: string;
  threadKey: string;
  snippet: string;
  isRead: number;
  category: string | null;
  threadCount?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

export function needsFullRead(snippet: string): boolean {
  const s = (snippet || '').toLowerCase();
  if (!s || s.length < 80) return true;
  const cues = [
    'please',
    'can you',
    'need your',
    'next steps',
    'action items',
    'deadline',
    'approve',
    'decision',
    '?',
  ];
  return cues.some((c) => s.includes(c));
}

function formatItem(row: SearchRow, body: string): string {
  return [
    `Subject: ${row.subject}`,
    `From: ${row.from}`,
    `DateUtc: ${row.dateUtc}`,
    `Mailbox: ${row.mailbox}`,
    '',
    body,
  ].join('\n');
}

function chunkItems(items: string[], budget: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const item of items) {
    const next = current ? `${current}\n\n---\n\n${item}` : item;
    if (next.length > budget && current) {
      chunks.push(current);
      current = item;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function summarizeWithRetry(task: string, content: string, outputMaxChars: number, timeoutMs: number, retryBudget: number) {
  try {
    return await withTimeout(
      handleLlmSummarize({ task, content, maxChars: outputMaxChars }),
      timeoutMs,
      'mail-summary'
    );
  } catch {
    const reduced = truncate(content, retryBudget);
    return await withTimeout(
      handleLlmSummarize({ task: `${task}\n\nRetry with concise focus.`, content: reduced, maxChars: outputMaxChars }),
      timeoutMs,
      'mail-summary-retry'
    );
  }
}

export async function handleMailSummary(args: MailSummaryInput) {
  const policy = getSummaryPolicy();
  const mode = args.mode ?? 'auto';
  const maxEmails = Math.min(args.maxEmails ?? policy.maxSearchResults, policy.maxSearchResults);

  const search = handleMailSearch({
    query: args.query,
    limit: maxEmails,
    threadCollapse: true,
    filters: args.filters,
  }) as { results?: SearchRow[]; nextCursor?: string | null; error?: string };

  if (search.error) return { error: search.error };
  const results = search.results ?? [];
  if (results.length === 0) {
    return {
      summary: 'No matching emails found.',
      modeUsed: mode,
      fallbackUsed: false,
      partialSummary: false,
      telemetry: { searched: 0, escalated: 0, fetchedFull: 0, chunked: false, chunkCount: 0, inputChars: 0 },
    };
  }

  let escalated = 0;
  let fetchedFull = 0;
  const items: string[] = [];

  for (const row of results) {
    const snippet = truncate(row.snippet || '', policy.snippetChars);
    const allowEscalate = mode !== 'snippet_only' && escalated < policy.escalationMaxEmails;
    const shouldEscalate = allowEscalate && (mode === 'selective_dive' || needsFullRead(snippet));

    if (!shouldEscalate) {
      items.push(formatItem(row, `Snippet:\n${snippet}`));
      continue;
    }

    escalated += 1;
    let body = '';
    if ((row.threadCount ?? 1) > 1 && row.threadKey) {
      const thread = handleMailGetThread({ threadKey: row.threadKey, maxBodyChars: 9000 }) as {
        error?: string;
        messages?: Array<{ from: string; dateUtc: number; bodyText: string | null }>;
      };
      if (!thread.error && Array.isArray(thread.messages)) {
        body = thread.messages
          .map((m, i) => `Thread message ${i + 1}\nFrom: ${m.from}\nDateUtc: ${m.dateUtc}\n${m.bodyText || ''}`)
          .join('\n\n');
      }
    }
    if (!body) {
      const full = handleMailGet({ mailId: row.mailId, includeBody: true, maxBodyChars: 9000 }) as {
        error?: string;
        bodyText?: string | null;
      };
      body = !full.error ? (full.bodyText || '') : '';
    }
    if (body) fetchedFull += 1;
    items.push(formatItem(row, body ? `Full body:\n${body}` : `Snippet:\n${snippet}`));
    if (policy.cooldownMs > 0) await sleep(policy.cooldownMs);
  }

  const chunks = chunkItems(items, policy.chunkCharBudget);
  const chunked = chunks.length > 1;
  const task = [
    'Summarize these emails for inbox triage.',
    'Return markdown with exact sections:',
    '1) Action Items',
    '2) Deadlines',
    '3) Decisions Needed',
    '4) Confidence and Gaps',
    '5) Short Executive Summary',
    'Do not invent facts.',
  ].join('\n');

  let partialSummary = false;
  let fallbackUsed = false;
  let finalSummary = '';

  try {
    let mergedInput = '';
    if (!chunked) {
      mergedInput = truncate(chunks[0], policy.promptCharBudget);
    } else {
      const chunkSummaries: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const c = truncate(chunks[i], policy.promptCharBudget);
        const r = await summarizeWithRetry(`${task}\n\nChunk ${i + 1}/${chunks.length}.`, c, 1500, policy.timeoutMs, policy.retryReducedBudget);
        if (!r || typeof r !== 'object' || 'error' in r) {
          partialSummary = true;
          continue;
        }
        chunkSummaries.push((r as { summary: string }).summary || '');
        if (policy.cooldownMs > 0) await sleep(policy.cooldownMs);
      }
      mergedInput = chunkSummaries.join('\n\n---\n\n');
      if (!mergedInput.trim()) throw new Error('All chunk summaries failed');
    }

    const res = await summarizeWithRetry(task, mergedInput, policy.outputMaxChars, policy.timeoutMs, policy.retryReducedBudget);
    if (!res || typeof res !== 'object' || 'error' in res) {
      throw new Error('Summarization failed');
    }
    finalSummary = (res as { summary: string }).summary || '';
  } catch {
    fallbackUsed = true;
    partialSummary = true;
    const snippetOnly = results
      .map((r) => formatItem(r, `Snippet:\n${truncate(r.snippet || '', policy.snippetChars)}`))
      .join('\n\n---\n\n');
    const fallback = await summarizeWithRetry(
      `${task}\n\nFallback mode: use snippets only and state uncertainty explicitly.`,
      truncate(snippetOnly, policy.retryReducedBudget),
      policy.outputMaxChars,
      policy.timeoutMs,
      Math.floor(policy.retryReducedBudget * 0.8)
    );
    if (fallback && typeof fallback === 'object' && !('error' in fallback)) {
      finalSummary = (fallback as { summary: string }).summary || '';
    } else {
      return { error: 'mail-summary failed and fallback could not complete' };
    }
  }

  return {
    modeUsed: mode,
    fallbackUsed,
    partialSummary,
    summary: finalSummary,
    telemetry: {
      searched: results.length,
      escalated,
      fetchedFull,
      chunked,
      chunkCount: chunks.length,
      inputChars: items.join('\n').length,
      policy,
    },
    nextCursor: search.nextCursor ?? null,
  };
}
