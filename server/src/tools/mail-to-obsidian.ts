import path from 'path';
import { handleMailSearch } from './mail-search.js';
import { handleMailGet } from './mail-get.js';
import { handleMailGetThread } from './mail-get-thread.js';
import { needsFullRead } from './mail-summary.js';
import { getLlmProvider, isLlmEnabled, getLlmConfig } from '../llm/provider.js';
import { writeObsidianNote } from '../ingest/obsidian-write.js';
import { getDb } from '../db/database.js';
import { logger } from '../log.js';

interface MailToObsidianInput {
  query?: string;
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
  maxEmails?: number;
  vault?: string;
  dryRun?: boolean;
  mode?: 'auto' | 'snippet_only' | 'selective_dive';
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
  threadParticipants?: string[];
}

interface EmailFact {
  mailId: number;
  dateUtc: number;
  subject: string;
  from: string;
  snippet: string;
  fullBody?: string;
}

interface LlmCluster {
  projectTitle: string;
  existingPageMatch: string | null;
  mailIds: number[];
  summary: string;
  confidence: number;
}

interface ClusterPlan {
  project: string;
  targetPath: string;
  newProject: boolean;
  emailsIncluded: number[];
  alreadyProcessed: number[];
  summary: string;
  confidence: number;
  action: 'created' | 'appended' | 'skipped_duplicate' | 'planned' | 'skipped_low_confidence';
}

const DEFAULT_MAX_EMAILS = 30;
const HARD_CAP_MAX_EMAILS = 60;
const MIN_CONFIDENCE = 0.4;

function isoDate(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

function slugify(s: string): string {
  return s
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'untitled';
}

function loadExistingProjects(vaultName: string): Array<{ path: string; title: string; aliases: string[] }> {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT path, title, frontmatter_json
         FROM obsidian_note
         WHERE vault = ? AND path LIKE '01_Notes/%'`
      )
      .all(vaultName) as Array<{ path: string; title: string; frontmatter_json: string | null }>;
    return rows.map((r) => {
      let aliases: string[] = [];
      if (r.frontmatter_json) {
        try {
          const fm = JSON.parse(r.frontmatter_json) as Record<string, unknown>;
          if (Array.isArray(fm.aliases)) aliases = (fm.aliases as unknown[]).map(String);
        } catch {}
      }
      return { path: r.path, title: r.title || path.basename(r.path, '.md'), aliases };
    });
  } catch (err) {
    logger.warn(`mail-to-obsidian: failed to load existing projects: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function buildLlmPrompt(emails: EmailFact[], projects: Array<{ path: string; title: string; aliases: string[] }>): { task: string; content: string } {
  const task = [
    'You are clustering emails by ongoing project for an Obsidian knowledge base.',
    '',
    'Output ONLY a JSON array. No prose, no markdown fences. Each element:',
    '{',
    '  "projectTitle": "Concise project name (≤60 chars)",',
    '  "existingPageMatch": "01_Notes/Foo.md" or null,',
    '  "mailIds": [<integers from input>],',
    '  "summary": "- bullet 1\\n- bullet 2\\n- bullet 3 (markdown bullet list, ≤8 bullets, factual only)",',
    '  "confidence": 0.0 to 1.0',
    '}',
    '',
    'Rules:',
    '- One cluster per genuine project. Single one-off emails that don\'t belong to any project go in a cluster titled "Misc" with low confidence (<0.3).',
    '- Prefer existingPageMatch when the project clearly matches an existing page. Match on title OR on aliases. Set null only if no existing page fits.',
    '- summary must reflect ONLY what the emails actually say. Do not invent facts. Include who/when/what action is requested.',
    '- Do not assign the same mailId to more than one cluster.',
    '- If you are unsure, lower confidence.',
  ].join('\n');

  const existingBlock = projects.length > 0
    ? 'EXISTING PROJECT PAGES (prefer these for existingPageMatch when relevant):\n'
      + projects.map((p) => `- ${p.path}  title="${p.title}"${p.aliases.length ? `  aliases=${JSON.stringify(p.aliases)}` : ''}`).join('\n')
    : 'EXISTING PROJECT PAGES: (none indexed)';

  const emailsBlock = emails
    .map((e) => {
      const body = e.fullBody ? `\nBody:\n${e.fullBody}` : `\nSnippet:\n${e.snippet}`;
      return `--- email mailId=${e.mailId}\nDate: ${isoDate(e.dateUtc)}\nFrom: ${e.from}\nSubject: ${e.subject}${body}`;
    })
    .join('\n\n');

  return {
    task,
    content: `${existingBlock}\n\n${emailsBlock}`,
  };
}

function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  // Try direct parse first
  try {
    const v = JSON.parse(trimmed);
    if (Array.isArray(v)) return v;
  } catch {}
  // Find first [ and matching last ]
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = trimmed.slice(start, end + 1);
  try {
    const v = JSON.parse(slice);
    if (Array.isArray(v)) return v;
  } catch {}
  return null;
}

function coerceClusters(raw: unknown[]): LlmCluster[] {
  const out: LlmCluster[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const projectTitle = typeof o.projectTitle === 'string' ? o.projectTitle.trim() : '';
    if (!projectTitle) continue;
    const mailIdsRaw = Array.isArray(o.mailIds) ? o.mailIds : [];
    const mailIds = mailIdsRaw
      .map((x) => (typeof x === 'number' ? x : typeof x === 'string' ? parseInt(x, 10) : NaN))
      .filter((n) => Number.isFinite(n));
    if (mailIds.length === 0) continue;
    out.push({
      projectTitle,
      existingPageMatch: typeof o.existingPageMatch === 'string' && o.existingPageMatch.length > 0 ? o.existingPageMatch : null,
      mailIds: mailIds as number[],
      summary: typeof o.summary === 'string' ? o.summary : '',
      confidence: typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0.5,
    });
  }
  return out;
}

function buildAppendBlock(date: string, summary: string, includedMailIds: number[]): string {
  const trimmedSummary = summary.trim();
  const body = trimmedSummary.length > 0 ? trimmedSummary : '_(no summary produced)_';
  const idsLine = `<!-- mail-ids: ${includedMailIds.join(', ')} -->`;
  return `### ${date}\n\n${body}\n\n${idsLine}`;
}

export async function handleMailToObsidian(args: MailToObsidianInput) {
  if (!isLlmEnabled()) {
    return { error: 'mail-to-obsidian requires LLM_PROVIDER=ollama. Set it and ensure Ollama is reachable.' };
  }

  const dryRun = args.dryRun ?? true;
  const maxEmails = Math.min(Math.max(1, args.maxEmails ?? DEFAULT_MAX_EMAILS), HARD_CAP_MAX_EMAILS);
  const mode = args.mode ?? 'auto';

  // ---- 1. Search ----
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
      clusters: [],
      unmatched: [],
      dryRun,
      telemetry: { searched: 0, escalated: 0, llmCalls: 0 },
    };
  }

  // ---- 2. Escalate to full body when warranted ----
  let escalated = 0;
  const ESCALATION_CAP = 12;
  const emails: EmailFact[] = [];
  for (const row of results) {
    const snippet = row.snippet || '';
    const fact: EmailFact = {
      mailId: row.mailId,
      dateUtc: row.dateUtc,
      subject: row.subject || '(no subject)',
      from: row.from || '',
      snippet,
    };
    const shouldEscalate =
      mode !== 'snippet_only' &&
      escalated < ESCALATION_CAP &&
      (mode === 'selective_dive' || needsFullRead(snippet));

    if (shouldEscalate) {
      escalated++;
      let body = '';
      if ((row.threadCount ?? 1) > 1 && row.threadKey) {
        const t = handleMailGetThread({ threadKey: row.threadKey, maxBodyChars: 6000 }) as {
          error?: string;
          messages?: Array<{ from: string; dateUtc: number; bodyText: string | null }>;
        };
        if (!t.error && Array.isArray(t.messages)) {
          body = t.messages
            .map((m, i) => `[msg ${i + 1}] From: ${m.from}\n${m.bodyText || ''}`)
            .join('\n\n');
        }
      }
      if (!body) {
        const g = handleMailGet({ mailId: row.mailId, includeBody: true, maxBodyChars: 6000 }) as {
          error?: string;
          bodyText?: string | null;
        };
        if (!g.error && g.bodyText) body = g.bodyText;
      }
      if (body) fact.fullBody = body.slice(0, 6000);
    }
    emails.push(fact);
  }

  // ---- 3. Resolve vault name for project lookup ----
  const vaultArg = args.vault;
  const vaultRootsEnv = process.env.OBSIDIAN_VAULT_ROOTS;
  const defaultVault = vaultRootsEnv
    ? vaultRootsEnv.split(',')[0].trim()
    : path.join(process.env.HOME || '/tmp', 'Obsidian');
  const resolvedVaultPath = path.resolve(vaultArg && path.isAbsolute(vaultArg) ? vaultArg : defaultVault);
  const vaultName = vaultArg && !path.isAbsolute(vaultArg) ? vaultArg : path.basename(resolvedVaultPath);

  // ---- 4. Load existing project anchors ----
  const projects = loadExistingProjects(vaultName);

  // ---- 5. Call LLM to cluster + summarize ----
  const provider = getLlmProvider();
  const cfg = getLlmConfig();
  const { task, content } = buildLlmPrompt(emails, projects);
  const PROMPT_BUDGET = 16000;
  const trimmedContent = content.length > PROMPT_BUDGET ? content.slice(0, PROMPT_BUDGET) + '\n[truncated]' : content;

  let llmRaw = '';
  try {
    const r = await provider.summarize({ task, content: trimmedContent, maxChars: cfg.ollamaMaxOutputTokens * 6 });
    llmRaw = r.summary || '';
  } catch (err) {
    return { error: `LLM clustering failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const rawArr = extractJsonArray(llmRaw);
  if (!rawArr) {
    return {
      error: 'LLM did not return a parseable JSON array',
      rawOutput: llmRaw.slice(0, 2000),
    };
  }
  const clusters = coerceClusters(rawArr);

  // ---- 6. Resolve targets, filter dedup, write (or stage) ----
  const validMailIds = new Set(emails.map((e) => e.mailId));
  const plan: ClusterPlan[] = [];
  const unmatched: Array<{ mailId: number; subject: string; reason: string }> = [];
  const claimed = new Set<number>();

  for (const c of clusters) {
    const cleanIds = c.mailIds.filter((id) => validMailIds.has(id) && !claimed.has(id));
    if (cleanIds.length === 0) continue;
    cleanIds.forEach((id) => claimed.add(id));

    const isLow = c.confidence < MIN_CONFIDENCE || /^misc$/i.test(c.projectTitle);
    if (isLow) {
      for (const id of cleanIds) {
        const e = emails.find((x) => x.mailId === id);
        unmatched.push({
          mailId: id,
          subject: e?.subject || '(unknown)',
          reason: isLow && /^misc$/i.test(c.projectTitle) ? 'misc cluster' : `low confidence ${c.confidence.toFixed(2)}`,
        });
      }
      plan.push({
        project: c.projectTitle,
        targetPath: '',
        newProject: false,
        emailsIncluded: cleanIds,
        alreadyProcessed: [],
        summary: c.summary,
        confidence: c.confidence,
        action: 'skipped_low_confidence',
      });
      continue;
    }

    const isExisting = c.existingPageMatch !== null && projects.some((p) => p.path === c.existingPageMatch);
    const targetPath = isExisting
      ? (c.existingPageMatch as string)
      : `00_Inbox/${slugify(c.projectTitle)}.md`;

    const today = new Date().toISOString().slice(0, 10);
    const mailIdsAsStrings = cleanIds.map(String);
    const appendBlock = buildAppendBlock(today, c.summary, cleanIds);
    const frontmatter: Record<string, unknown> = isExisting
      ? {}
      : { type: 'project', status: 'draft', created: today, source: 'mail-to-obsidian' };

    if (dryRun) {
      // Compute would-be dedup by peeking at existing frontmatter
      let alreadyProcessed: number[] = [];
      try {
        const fs = await import('fs');
        const abs = path.join(resolvedVaultPath, targetPath);
        if (fs.existsSync(abs)) {
          const matter = (await import('gray-matter')).default;
          const raw = fs.readFileSync(abs, 'utf8');
          const parsed = matter(raw);
          const existing = Array.isArray((parsed.data as Record<string, unknown>).processed_mail_ids)
            ? ((parsed.data as Record<string, unknown>).processed_mail_ids as unknown[]).map(String)
            : [];
          alreadyProcessed = cleanIds.filter((id) => existing.includes(String(id)));
        }
      } catch {}
      plan.push({
        project: c.projectTitle,
        targetPath,
        newProject: !isExisting,
        emailsIncluded: cleanIds.filter((id) => !alreadyProcessed.includes(id)),
        alreadyProcessed,
        summary: c.summary,
        confidence: c.confidence,
        action: alreadyProcessed.length === cleanIds.length ? 'skipped_duplicate' : 'planned',
      });
      continue;
    }

    try {
      const res = writeObsidianNote({
        vault: vaultArg,
        path: targetPath,
        mode: 'upsert',
        body: appendBlock,
        frontmatter,
        appendUnderHeading: 'Email Log',
        processedMessageIds: mailIdsAsStrings,
      });
      plan.push({
        project: c.projectTitle,
        targetPath: res.path,
        newProject: !isExisting,
        emailsIncluded: res.newlyProcessed.map((s) => parseInt(s, 10)),
        alreadyProcessed: res.alreadyProcessed.map((s) => parseInt(s, 10)),
        summary: c.summary,
        confidence: c.confidence,
        action: res.action,
      });
    } catch (err) {
      plan.push({
        project: c.projectTitle,
        targetPath,
        newProject: !isExisting,
        emailsIncluded: cleanIds,
        alreadyProcessed: [],
        summary: c.summary,
        confidence: c.confidence,
        action: 'planned',
      });
      logger.error(`mail-to-obsidian write failed for ${targetPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Any emails not claimed by any cluster
  for (const e of emails) {
    if (!claimed.has(e.mailId)) {
      unmatched.push({ mailId: e.mailId, subject: e.subject, reason: 'no cluster assigned' });
    }
  }

  return {
    dryRun,
    vault: vaultName,
    clusters: plan,
    unmatched,
    telemetry: {
      searched: results.length,
      escalated,
      llmCalls: 1,
      existingProjectsLoaded: projects.length,
      llmModel: cfg.ollamaSummarizerModel,
    },
  };
}
