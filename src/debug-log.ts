import { appendFile, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const MAX_LOG_BYTES = 100_000;

const getLogPath = (): string => {
  if (process.env.WARCRAFT_DEBUG_FILE) return process.env.WARCRAFT_DEBUG_FILE;
  const base =
    process.env.XDG_DATA_HOME && process.platform !== 'win32'
      ? process.env.XDG_DATA_HOME
      : join(homedir(), '.local', 'share');
  return join(
    base,
    'opencode',
    'storage',
    'plugin',
    '@pantheon-ai',
    'opencode-warcraft-notifications',
    'warcraft-debug.log',
  );
};

/**
 * Append a diagnostic line to the plugin's debug log file.
 *
 * Server-plugin stdout/stderr is not visible when OpenCode runs as a
 * background service, so lifecycle events and errors are recorded here
 * instead. Best-effort: never throws.
 *
 * Gated: informational lines are only written while debug logging is enabled
 * (see `setDebugEnabled`); use `errorLogFile` for lines that must always be
 * recorded.
 */
export const debugLogFile = async (message: string, data?: unknown): Promise<void> => {
  if (!enabled) return;
  await writeLogLine(message, data);
};

/**
 * Record a diagnostic line unconditionally, regardless of the `debug` flag.
 * Reserved for errors and fail-open paths that must leave a trail even when
 * verbose logging is disabled.
 */
export const errorLogFile = async (message: string, data?: unknown): Promise<void> => {
  await writeLogLine(message, data);
};

let enabled = true;

/**
 * Toggle verbose (informational) file logging. Setting the WARCRAFT_DEBUG_FILE
 * env var forces logging on regardless of this flag. Errors are never gated.
 */
export const setDebugEnabled = (value: boolean): void => {
  enabled = Boolean(process.env.WARCRAFT_DEBUG_FILE) || value;
};

const writeLogLine = async (message: string, data?: unknown): Promise<void> => {
  try {
    const path = getLogPath();
    await mkdir(dirname(path), { recursive: true });
    try {
      const info = await stat(path);
      if (info.size > MAX_LOG_BYTES) {
        const content = await readFile(path, 'utf8');
        await writeFile(path, content.slice(-Math.floor(MAX_LOG_BYTES / 2)));
      }
    } catch {
      // Missing file: nothing to trim.
    }
    const line = `${new Date().toISOString()} ${message}${data !== undefined ? ` ${JSON.stringify(data)}` : ''}\n`;
    await appendFile(path, line);
  } catch {
    // Diagnostics must never break the plugin.
  }
};

export const getDebugLogPath = getLogPath;
