/** Minimal logger interface: pass your own (pino, winston, console, ...) via `createPostSync({ logger })`. */
export interface Logger {
  info(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  error(message: string, ...extra: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (m, ...e) => console.info(`[post-sync] ${m}`, ...e),
  warn: (m, ...e) => console.warn(`[post-sync] ${m}`, ...e),
  error: (m, ...e) => console.error(`[post-sync] ${m}`, ...e),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * An error as text for the log message itself. Loggers such as pino ignore a trailing Error argument, so error logs
 * put this in the message and still pass the error as the extra argument.
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
