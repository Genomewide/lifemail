import { syncMail, type MailSyncResult } from '../ingest/mail.js';

interface MailSyncInput {
  mode?: string;
  rootPaths?: string[];
  sinceUtc?: number;
  maxFiles?: number;
  includeBodies?: boolean;
  includeAttachments?: boolean;
}

export async function handleMailSync(args: MailSyncInput): Promise<MailSyncResult> {
  return syncMail({
    mode: args.mode ?? 'incremental',
    rootPaths: args.rootPaths,
    sinceUtc: args.sinceUtc,
    maxFiles: args.maxFiles,
    includeBodies: args.includeBodies,
    includeAttachments: args.includeAttachments,
  });
}
