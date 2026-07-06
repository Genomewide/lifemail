import { writeObsidianNote, type WriteMode } from '../ingest/obsidian-write.js';

interface ObsidianWriteInput {
  vault?: string;
  path?: string;
  mode?: WriteMode;
  body?: string;
  frontmatter?: Record<string, unknown>;
  appendUnderHeading?: string;
  processedMessageIds?: string[];
}

export function handleObsidianWrite(args: ObsidianWriteInput) {
  if (!args.path) return { error: 'path is required' };
  if (typeof args.body !== 'string') return { error: 'body is required (string)' };
  if (args.mode && !['create', 'append', 'upsert'].includes(args.mode)) {
    return { error: `invalid mode: ${args.mode}` };
  }
  try {
    return writeObsidianNote({
      vault: args.vault,
      path: args.path,
      mode: args.mode,
      body: args.body,
      frontmatter: args.frontmatter,
      appendUnderHeading: args.appendUnderHeading,
      processedMessageIds: args.processedMessageIds,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
