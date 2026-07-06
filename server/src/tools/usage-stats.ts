import { usageTracker, type UsageSummary } from '../usage-tracker.js';

export function handleUsageStats(): UsageSummary {
  return usageTracker.getSummary();
}
