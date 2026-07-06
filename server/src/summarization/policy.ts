export interface SummaryPolicy {
  snippetChars: number;
  maxSearchResults: number;
  escalationMaxEmails: number;
  promptCharBudget: number;
  chunkCharBudget: number;
  outputMaxChars: number;
  timeoutMs: number;
  cooldownMs: number;
  retryReducedBudget: number;
}

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getSummaryPolicy(): SummaryPolicy {
  return {
    snippetChars: toInt(process.env.SUMMARY_SNIPPET_CHARS, 200),
    maxSearchResults: toInt(process.env.SUMMARY_MAX_SEARCH_RESULTS, 20),
    escalationMaxEmails: toInt(process.env.SUMMARY_ESCALATION_MAX_EMAILS, 5),
    promptCharBudget: toInt(process.env.SUMMARY_PROMPT_CHAR_BUDGET, 10000),
    chunkCharBudget: toInt(process.env.SUMMARY_CHUNK_CHAR_BUDGET, 9000),
    outputMaxChars: toInt(process.env.SUMMARY_OUTPUT_MAX_CHARS, 7000),
    timeoutMs: toInt(process.env.SUMMARY_TIMEOUT_MS, 90000),
    cooldownMs: toInt(process.env.SUMMARY_COOLDOWN_MS, 1000),
    retryReducedBudget: toInt(process.env.SUMMARY_RETRY_REDUCED_BUDGET, 6000),
  };
}
