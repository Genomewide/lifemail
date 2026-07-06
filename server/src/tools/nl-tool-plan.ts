import { getLlmProvider, type PlannedToolCall, type ToolSchemaRef } from '../llm/provider.js';
import { usageTracker } from '../usage-tracker.js';

interface NlToolPlanInput {
  request?: string;
  maxSteps?: number;
}

const ALLOWED_TOOLS = new Set([
  'sync-status',
  'mail-search',
  'mail-get',
  'mail-get-thread',
  'calendar-search',
  'calendar-get',
  'obsidian-search',
  'obsidian-get',
  'usage-stats',
]);

function clampSearchLimit(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (typeof out.limit === 'number') {
    out.limit = Math.max(1, Math.min(50, out.limit));
  }
  return out;
}

function sanitizeStep(step: PlannedToolCall): PlannedToolCall | null {
  if (!ALLOWED_TOOLS.has(step.toolName)) return null;
  let args = step.arguments;
  if (!args || Array.isArray(args)) return null;
  if (['mail-search', 'calendar-search', 'obsidian-search'].includes(step.toolName)) {
    args = clampSearchLimit(args);
  }
  return {
    toolName: step.toolName,
    arguments: args,
    reason: step.reason,
    confidence: Math.max(0, Math.min(1, step.confidence)),
  };
}

export async function handleNlToolPlan(args: NlToolPlanInput, availableTools: ToolSchemaRef[]) {
  const request = (args.request || '').trim();
  if (!request) {
    return { error: 'request is required' };
  }
  const maxSteps = Math.max(1, Math.min(args.maxSteps ?? 4, 8));
  const provider = getLlmProvider();
  const allowedRefs = availableTools.filter((t) => ALLOWED_TOOLS.has(t.name));
  const plan = await provider.planToolCalls(request, allowedRefs, maxSteps);
  usageTracker.setRuntimeModel(plan.provider, plan.model, true);

  const safeSteps: PlannedToolCall[] = [];
  const dropped: string[] = [];
  for (const step of plan.steps) {
    const safe = sanitizeStep(step);
    if (safe) {
      safeSteps.push(safe);
    } else {
      dropped.push(`Dropped unsafe step for tool "${step.toolName}"`);
    }
  }

  return {
    provider: plan.provider,
    model: plan.model,
    request,
    maxSteps,
    plan: safeSteps.slice(0, maxSteps),
    warnings: [...plan.warnings, ...dropped],
    allowedTools: Array.from(ALLOWED_TOOLS),
  };
}
