import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './logger.js';

const log = createLogger({ module: 'opencode-plugin-warcraft-notifications' });

const execFileAsync = promisify(execFile);

/**
 * Run a player binary without a shell (V2-safe: no `$` helper).
 */
const runPlayer = async (command: string, args: string[]): Promise<void> => {
  await execFileAsync(command, args);
};

/**
 * Play a sound file using platform-specific commands.
 *
 * V2 plugins no longer receive the Bun `$` shell helper, so this uses
 * `node:child_process` directly (works in Bun and Node).
 *
 * @param soundPath - Full path to the sound file (must exist)
 */
export const playSoundFile = async (soundPath: string): Promise<void> => {
  if (process.platform === 'darwin') {
    await runPlayer('afplay', [soundPath]);
    return;
  }
  if (process.platform === 'linux') {
    try {
      await runPlayer('paplay', [soundPath]);
    } catch {
      await runPlayer('aplay', [soundPath]);
    }
    return;
  }
  if (process.platform === 'win32') {
    log.warn('Windows sound playback not yet supported', { soundPath });
    return;
  }
  log.warn('Unsupported platform for sound playback', { platform: process.platform, soundPath });
};

/**
 * Play the system fallback sound when the primary file is missing.
 *
 * @param soundPath - Missing primary sound path (for logging)
 */
export const playFallbackSound = async (soundPath: string): Promise<void> => {
  if (process.platform === 'darwin') {
    const fallbackSound = '/System/Library/Sounds/Glass.aiff';
    log.warn('Primary sound not found, using fallback', { soundPath, fallbackSound });
    await runPlayer('afplay', [fallbackSound]);
    return;
  }
  if (process.platform === 'linux') {
    log.warn('Primary sound not found, using system sound', { soundPath });
    await runPlayer('canberra-gtk-play', ['--id=message']);
    return;
  }
  log.warn('Windows sound playback not yet supported', { soundPath });
};
