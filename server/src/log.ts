// All logging goes to stderr — stdout is reserved for MCP protocol.

export function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown): void {
  const ts = new Date().toISOString();
  const line = meta !== undefined
    ? `[${ts}] ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}`
    : `[${ts}] ${level.toUpperCase()} ${msg}`;
  process.stderr.write(line + '\n');
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
  info:  (msg: string, meta?: unknown) => log('info',  msg, meta),
  warn:  (msg: string, meta?: unknown) => log('warn',  msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
};
