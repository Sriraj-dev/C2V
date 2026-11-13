/** Safe error summary for logs: Drizzle/pg errors embed query params (PII) in message/cause, so keep only the basics. */
export function errInfo(err: unknown): { name?: string; message?: string; code?: unknown } {
  if (!(err instanceof Error)) return {};
  const code = (err as { code?: unknown }).code;
  // Drizzle wraps the driver error: message is "Failed query: <sql> params: ...".
  const message = err.message.startsWith('Failed query') ? 'database query failed' : err.message;
  return { name: err.name, message: message.slice(0, 200), code: code ?? (err.cause as { code?: unknown } | undefined)?.code };
}
