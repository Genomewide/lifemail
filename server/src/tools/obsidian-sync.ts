import { syncObsidian, type ObsidianSyncResult } from '../ingest/obsidian.js';

interface ObsidianSyncInput {
  mode?: string;
  vaultRoots?: string[];
  excludeGlobs?: string[];
  maxFiles?: number;
  includeBody?: boolean;
  maxBodyChars?: number;
}

export async function handleObsidianSync(args: ObsidianSyncInput): Promise<ObsidianSyncResult | { error: string }> {
  const vaultRoots = args.vaultRoots ?? [];
  if (vaultRoots.length === 0) {
    return { error: 'vaultRoots is required and must contain at least one path' };
  }

  return syncObsidian({
    mode: args.mode ?? 'incremental',
    vaultRoots,
    excludeGlobs: args.excludeGlobs,
    maxFiles: args.maxFiles,
    includeBody: args.includeBody,
    maxBodyChars: args.maxBodyChars,
  });
}
