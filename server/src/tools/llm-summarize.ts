import { getLlmProvider } from '../llm/provider.js';
import { usageTracker } from '../usage-tracker.js';

interface LlmSummarizeInput {
  task?: string;
  content?: string;
  maxChars?: number;
}

export async function handleLlmSummarize(args: LlmSummarizeInput) {
  const content = (args.content || '').trim();
  if (!content) {
    return { error: 'content is required' };
  }

  const provider = getLlmProvider();
  const task = (args.task || 'Summarize this content for actionable highlights').trim();
  const maxChars = Math.max(200, Math.min(args.maxChars ?? 6000, 30000));
  const result = await provider.summarize({ task, content, maxChars });
  usageTracker.setRuntimeModel(result.provider, result.model, true);

  return {
    provider: result.provider,
    model: result.model,
    task,
    summary: result.summary,
  };
}
