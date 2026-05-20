/**
 * Structured logger shared across all Fola always-on services.
 * Uses service tag to make multi-service PM2 logs scannable.
 */

export function createLogger(serviceTag) {
  const prefix = `[${serviceTag}]`;
  return {
    info: msg => write('info', prefix, msg),
    warn: msg => write('warn', prefix, msg),
    error: msg => write('error', prefix, msg),
  };
}

function write(level, prefix, msg) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const stream = level === 'error' ? process.stderr : process.stdout;
  const marker = level === 'error' ? 'ERR' : level === 'warn' ? 'WRN' : 'INFO';
  stream.write(`${ts} ${marker} ${prefix} ${msg}\n`);
}
