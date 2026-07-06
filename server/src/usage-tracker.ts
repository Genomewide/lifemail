export type ModelTier = 'opus' | 'sonnet' | 'haiku';

interface ModelPricing {
  name: string;
  inputPerMTok: number;
}

const PRICING: Record<ModelTier, ModelPricing> = {
  opus:   { name: 'Claude Opus',   inputPerMTok: 15 },
  sonnet: { name: 'Claude Sonnet', inputPerMTok: 3 },
  haiku:  { name: 'Claude Haiku',  inputPerMTok: 0.80 },
};

const CHARS_PER_TOKEN = 4;
const MAX_CALL_HISTORY = 50;

export interface CallRecord {
  toolName: string;
  charCount: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  timestampUtc: number;
}

export interface ToolStats {
  toolName: string;
  callCount: number;
  totalChars: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface UsageSummary {
  provider: string;
  model: string;
  isEstimated: boolean;
  sessionStartUtc: number;
  totalCalls: number;
  totalChars: number;
  totalTokens: number;
  totalEstimatedCostUsd: number;
  byTool: ToolStats[];
  recentCalls: CallRecord[];
}

export interface CallUsage {
  provider: string;
  thisCall: {
    charCount: number;
    estimatedTokens: number;
    estimatedCostUsd: number;
  };
  session: {
    totalCalls: number;
    totalTokens: number;
    totalEstimatedCostUsd: number;
  };
  model: string;
  isEstimated: boolean;
}

class UsageTracker {
  private modelTier: ModelTier = 'opus';
  private provider = 'claude';
  private modelName = PRICING.opus.name;
  private isEstimated = true;
  private customInputPerMTok: number | null = null;
  private sessionStartUtc = Math.floor(Date.now() / 1000);
  private calls: CallRecord[] = [];
  private toolTotals = new Map<string, { callCount: number; totalChars: number; totalTokens: number; totalCostUsd: number }>();
  private _totalCalls = 0;
  private _totalChars = 0;
  private _totalTokens = 0;
  private _totalCostUsd = 0;

  setModel(tier: ModelTier): void {
    this.modelTier = tier;
    this.provider = 'claude';
    this.modelName = PRICING[tier].name;
    this.isEstimated = true;
    this.customInputPerMTok = null;
  }

  setRuntimeModel(provider: string, model: string, isEstimated = true, inputPerMTok?: number): void {
    this.provider = provider;
    this.modelName = model;
    this.isEstimated = isEstimated;
    this.customInputPerMTok = typeof inputPerMTok === 'number' && Number.isFinite(inputPerMTok)
      ? Math.max(0, inputPerMTok)
      : null;
  }

  private currentInputCostPerMTok(): number {
    if (this.customInputPerMTok != null) return this.customInputPerMTok;
    return PRICING[this.modelTier].inputPerMTok;
  }

  record(toolName: string, responseText: string): CallUsage {
    const inputPerMTok = this.currentInputCostPerMTok();
    const charCount = responseText.length;
    const estimatedTokens = Math.ceil(charCount / CHARS_PER_TOKEN);
    const estimatedCostUsd = Math.round((estimatedTokens / 1_000_000) * inputPerMTok * 1_000_000) / 1_000_000;
    const timestampUtc = Math.floor(Date.now() / 1000);

    const record: CallRecord = { toolName, charCount, estimatedTokens, estimatedCostUsd, timestampUtc };

    // Maintain capped history
    this.calls.push(record);
    if (this.calls.length > MAX_CALL_HISTORY) {
      this.calls.shift();
    }

    // Update per-tool totals
    const existing = this.toolTotals.get(toolName);
    if (existing) {
      existing.callCount++;
      existing.totalChars += charCount;
      existing.totalTokens += estimatedTokens;
      existing.totalCostUsd += estimatedCostUsd;
    } else {
      this.toolTotals.set(toolName, {
        callCount: 1,
        totalChars: charCount,
        totalTokens: estimatedTokens,
        totalCostUsd: estimatedCostUsd,
      });
    }

    // Update session totals
    this._totalCalls++;
    this._totalChars += charCount;
    this._totalTokens += estimatedTokens;
    this._totalCostUsd += estimatedCostUsd;

    return {
      provider: this.provider,
      thisCall: { charCount, estimatedTokens, estimatedCostUsd },
      session: {
        totalCalls: this._totalCalls,
        totalTokens: this._totalTokens,
        totalEstimatedCostUsd: Math.round(this._totalCostUsd * 1_000_000) / 1_000_000,
      },
      model: this.modelName,
      isEstimated: this.isEstimated,
    };
  }

  getSummary(): UsageSummary {
    const byTool: ToolStats[] = [];

    for (const [toolName, stats] of this.toolTotals) {
      byTool.push({
        toolName,
        callCount: stats.callCount,
        totalChars: stats.totalChars,
        totalTokens: stats.totalTokens,
        totalCostUsd: Math.round(stats.totalCostUsd * 1_000_000) / 1_000_000,
      });
    }

    // Sort by cost descending
    byTool.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    return {
      provider: this.provider,
      model: this.modelName,
      isEstimated: this.isEstimated,
      sessionStartUtc: this.sessionStartUtc,
      totalCalls: this._totalCalls,
      totalChars: this._totalChars,
      totalTokens: this._totalTokens,
      totalEstimatedCostUsd: Math.round(this._totalCostUsd * 1_000_000) / 1_000_000,
      byTool,
      recentCalls: this.calls.slice(-10),
    };
  }
}

export const usageTracker = new UsageTracker();
