/** One-line JSON logs (Fly's log viewer and `fly logs` handle these well). */
type Level = 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
