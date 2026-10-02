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
