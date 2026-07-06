import { logger } from '../log.js';

export type LlmProviderName = 'none' | 'ollama';

export interface ToolSchemaRef {
  name: string;
  description: string;
}

export interface PlannedToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  confidence: number;
}

export interface ToolPlanResult {
  provider: LlmProviderName;
  model: string;
  steps: PlannedToolCall[];
  warnings: string[];
}

export interface SummarizeParams {
  task: string;
  content: string;
  maxChars?: number;
}

export interface SummarizeResult {
  provider: LlmProviderName;
  model: string;
  summary: string;
}

interface LlmProvider {
  readonly provider: LlmProviderName;
  readonly plannerModel: string;
  readonly summarizerModel: string;
  checkHealth(): Promise<void>;
  summarize(params: SummarizeParams): Promise<SummarizeResult>;
  planToolCalls(request: string, tools: ToolSchemaRef[], maxSteps: number): Promise<ToolPlanResult>;
}

export interface LlmConfig {
  provider: LlmProviderName;
  ollamaBaseUrl: string;
  ollamaPlannerModel: string;
  ollamaSummarizerModel: string;
  ollamaTimeoutMs: number;
  ollamaMaxOutputTokens: number;
}

function readLlmConfig(): LlmConfig {
  const providerRaw = (process.env.LLM_PROVIDER || 'none').trim().toLowerCase();
  const provider = providerRaw === 'ollama' ? 'ollama' : 'none';
  const timeout = parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10);
  const maxOut = parseInt(process.env.OLLAMA_MAX_OUTPUT_TOKENS || '1200', 10);
  return {
    provider,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    ollamaPlannerModel: process.env.OLLAMA_MODEL_PLANNER || 'gpt-oss:20b',
    ollamaSummarizerModel: process.env.OLLAMA_MODEL_SUMMARIZER || 'gpt-oss:20b',
    ollamaTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60000,
    ollamaMaxOutputTokens: Number.isFinite(maxOut) && maxOut > 0 ? maxOut : 1200,
  };
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ac.signal });
    if (!resp.ok) {
      const msg = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${msg}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
    }
    throw new Error('Planner did not return valid JSON object');
  }
}

class OllamaProvider implements LlmProvider {
  readonly provider: LlmProviderName = 'ollama';

  constructor(private readonly config: LlmConfig) {}

  get plannerModel(): string {
    return this.config.ollamaPlannerModel;
  }

  get summarizerModel(): string {
    return this.config.ollamaSummarizerModel;
  }

  async checkHealth(): Promise<void> {
    await fetchJsonWithTimeout(
      `${this.config.ollamaBaseUrl}/api/tags`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      this.config.ollamaTimeoutMs
    );
  }

  async summarize(params: SummarizeParams): Promise<SummarizeResult> {
    const prompt = [
      'You are a concise assistant. Summarize the provided content.',
      `Task: ${params.task}`,
      '',
      'Return plain text only.',
      '',
      'CONTENT START',
      params.content,
      'CONTENT END',
    ].join('\n');

    const payload = {
      model: this.config.ollamaSummarizerModel,
      prompt,
      stream: false,
      options: { num_predict: this.config.ollamaMaxOutputTokens },
    };
    const data = await fetchJsonWithTimeout(
      `${this.config.ollamaBaseUrl}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      },
      this.config.ollamaTimeoutMs
    ) as { response?: string };

    const text = (data.response || '').trim();
    if (!text) {
      throw new Error('Ollama returned an empty summary');
    }

    return {
      provider: this.provider,
      model: this.config.ollamaSummarizerModel,
      summary: params.maxChars ? text.slice(0, params.maxChars) : text,
    };
  }

  async planToolCalls(request: string, tools: ToolSchemaRef[], maxSteps: number): Promise<ToolPlanResult> {
    const toolsList = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
    const prompt = [
      'You are a tool planner. Convert user requests into a safe MCP tool execution plan.',
      'Output STRICT JSON object only. No markdown.',
      'Required JSON shape:',
      '{"steps":[{"toolName":"mail-search","arguments":{},"reason":"...","confidence":0.0}],"warnings":["..."]}',
      `Rules: up to ${maxSteps} steps, toolName must come from provided list, confidence between 0 and 1.`,
      '',
      'Allowed tools:',
      toolsList,
      '',
      `User request: ${request}`,
    ].join('\n');

    const payload = {
      model: this.config.ollamaPlannerModel,
      prompt,
      stream: false,
      options: { num_predict: this.config.ollamaMaxOutputTokens },
    };
    const data = await fetchJsonWithTimeout(
      `${this.config.ollamaBaseUrl}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      },
      this.config.ollamaTimeoutMs
    ) as { response?: string };

    const parsed = parseJsonObject(data.response || '');
    const stepsRaw = Array.isArray(parsed.steps) ? parsed.steps : [];
    const warningsRaw = Array.isArray(parsed.warnings) ? parsed.warnings : [];

    const steps: PlannedToolCall[] = [];
    for (const step of stepsRaw.slice(0, maxSteps)) {
      if (!step || typeof step !== 'object') continue;
      const toolName = typeof (step as Record<string, unknown>).toolName === 'string'
        ? (step as Record<string, unknown>).toolName as string
        : '';
      const args = (step as Record<string, unknown>).arguments;
      const reason = typeof (step as Record<string, unknown>).reason === 'string'
        ? (step as Record<string, unknown>).reason as string
        : '';
      const confidenceRaw = (step as Record<string, unknown>).confidence;
      const confidenceNum = typeof confidenceRaw === 'number' ? confidenceRaw : 0;
      if (!toolName || !args || typeof args !== 'object' || Array.isArray(args)) continue;
      steps.push({
        toolName,
        arguments: args as Record<string, unknown>,
        reason: reason || 'Generated by planner',
        confidence: Math.max(0, Math.min(1, confidenceNum)),
      });
    }

    return {
      provider: this.provider,
      model: this.config.ollamaPlannerModel,
      steps,
      warnings: warningsRaw.filter((w): w is string => typeof w === 'string'),
    };
  }
}

let activeProvider: LlmProvider | null = null;
let configCache: LlmConfig | null = null;

export function getLlmConfig(): LlmConfig {
  if (!configCache) {
    configCache = readLlmConfig();
  }
  return configCache;
}

export function isLlmEnabled(): boolean {
  return getLlmConfig().provider !== 'none';
}

export function getLlmProvider(): LlmProvider {
  const config = getLlmConfig();
  if (config.provider === 'none') {
    throw new Error('LLM provider is disabled. Set LLM_PROVIDER=ollama to enable local LLM features.');
  }
  if (!activeProvider) {
    activeProvider = new OllamaProvider(config);
  }
  return activeProvider;
}

export async function validateLlmStartup(): Promise<void> {
  const config = getLlmConfig();
  if (config.provider === 'none') return;
  const provider = getLlmProvider();
  logger.info('Validating LLM provider connectivity', {
    provider: config.provider,
    baseUrl: config.ollamaBaseUrl,
    plannerModel: config.ollamaPlannerModel,
    summarizerModel: config.ollamaSummarizerModel,
  });
  await provider.checkHealth();
}
