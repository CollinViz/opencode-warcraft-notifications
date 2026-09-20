import type { Plugin as V1Plugin } from '@opencode-ai/plugin';
import { Plugin as V2Plugin } from '@opencode/plugin';
import { createLogger } from './logger.js';
import {
  getRandomSoundPathFromFaction,
  soundExists,
  determineSoundFaction,
  getSoundDescription,
} from './sounds/index.js';
import { installBundledSoundsIfMissing } from './bundled-sounds.js';
import { loadPluginConfig } from './config/index.js';
import { validateAndSanitizeConfig } from './schema-validator.js';
import type { WarcraftNotificationConfig } from './config/index.js';
import { extractFilename, getIdleSummary } from './notification-utils.js';
import { playSoundFile, playFallbackSound } from './sound-player.js';
import { debugLogFile } from './debug-log.js';
/* eslint-disable jsdoc/require-param */

const log = createLogger({ module: 'opencode-plugin-warcraft-notifications' });

export const PLUGIN_ID = 'warcraft-notifications';
export const PLUGIN_NAME = '@pantheon-ai/opencode-warcraft-notifications';

// Constants for toast durations and cache keys
const TOAST_DURATION = {
  SUCCESS: 3000,
  WARNING: 5000,
  INFO: 4000,
} as const;

const CACHE_KEY_NOTIFIED_MISSING = '_notified_missing';

/**
 * Resolve plugin configuration.
 *
 * V2 passes options via `ctx.options` (from the `plugins: [{ package, options }]`
 * entry in `opencode.json`). Older `plugin.json` files are used as a fallback
 * so existing installs keep working.
 *
 * @param options - Raw `ctx.options` (V2) or `undefined` for V1 file loading
 */
export const resolvePluginConfig = async (
  options?: unknown,
): Promise<WarcraftNotificationConfig> => {
  const hasInlineOptions = !!options && Object.keys(options as object).length > 0;
  if (hasInlineOptions) {
    return validateAndSanitizeConfig(options);
  }
  return await loadPluginConfig(PLUGIN_NAME);
};

/**
 * Normalize a server event payload across V1 (`properties`) and V2 (`data`) shapes.
 */
const getPayload = (event: Record<string, unknown>): Record<string, unknown> =>
  (event.properties ?? event.data ?? {}) as Record<string, unknown>;

/**
 * Race a promise against a timeout so a hung client call can never
 * silently swallow an event.
 */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);

/**
 * Shared idle-sound state machine (transport-agnostic so V1 and V2 share behavior).
 *
 * @param isSubagentSession - Optional V2 check: resolves whether a sessionID
 *   belongs to a child (subagent) session via its `parentID`. V1 passes none
 *   and keeps the original counter-only behavior.
 */
const createIdleHandler = (
  pluginConfig: WarcraftNotificationConfig,
  hooks?: { isSubagentSession?: (sessionID: string) => Promise<boolean> },
) => {
  const checkedSoundCache = new Map<string, boolean>();
  let subtasksRunning = 0;
  let subtaskTimer: ReturnType<typeof setTimeout> | null = null;
  const SUBTASK_TIMEOUT_MS = pluginConfig.subagentSilenceTimeoutMs ?? 30_000;
  // Guards against double playback when a single completion emits both
  // `session.execution.*` and `session.idle`.
  const lastPlayedBySession = new Map<string, number>();
  const PLAY_DEBOUNCE_MS = 15_000;
  let lastMessage: { messageID: string | null; text: string | null } = {
    messageID: null,
    text: null,
  };

  const ensureAndGetSoundPath = async () => {
    const explicitDataDir = pluginConfig.soundsDir || undefined;
    const faction = pluginConfig.faction || 'both';
    const soundPath = getRandomSoundPathFromFaction(faction, explicitDataDir);
    const filename = extractFilename(soundPath);
    const soundFaction = determineSoundFaction(filename);

    if (checkedSoundCache.get(filename) === true) return soundPath;

    try {
      const existsLocally = await soundExists(filename, soundFaction, explicitDataDir);
      if (existsLocally) {
        checkedSoundCache.set(filename, true);
        return soundPath;
      }
      return soundPath;
    } catch (error) {
      log.error('Error ensuring sound available', { error });
      return soundPath;
    }
  };

  const playIdleSound = async (soundPath: string, existsLocally: boolean) => {
    try {
      if (existsLocally) {
        await playSoundFile(soundPath);
      } else {
        await playFallbackSound(soundPath);
        return false;
      }
      return true;
    } catch (error) {
      log.error('Failed to play sound', { error, soundPath });
      await debugLogFile('playback failed', {
        soundPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return existsLocally;
    }
  };

  const handleSessionIdle = async (
    summary: string,
    notify: (title: string, message: string) => Promise<void>,
    notifyMissing: (filename: string) => Promise<void>,
  ) => {
    const soundPath = await ensureAndGetSoundPath();
    const filename = extractFilename(soundPath);
    const fileSoundFaction = determineSoundFaction(filename);
    const existsLocally = await soundExists(filename, fileSoundFaction, pluginConfig.soundsDir);

    try {
      await playIdleSound(soundPath, existsLocally);
      console.log(
        `[warcraft-notifications] Played ${filename}${existsLocally ? '' : ' (fallback sound)'}`,
      );
      await debugLogFile('played sound', { filename, existsLocally, summary });
      if (!existsLocally) {
        await notifyMissing(filename);
      }

      const soundDescription = getSoundDescription(filename);
      const toastTitle = soundDescription || 'opencode';
      const showToast = pluginConfig.showDescriptionInToast !== false;
      if (showToast) {
        await notify(toastTitle, summary);
      }
    } catch (error) {
      log.error('Failed to play sound or show notification', { error });
    }
  };

  /**
   * Process one server event. Returns the idle summary when a sound was played,
   * otherwise `undefined`. The caller supplies transport-specific notify fns.
   */
  const handleEvent = async (
    event: { type: string; properties?: unknown; data?: unknown },
    notify: (title: string, message: string) => Promise<void>,
    notifyMissing: (filename: string) => Promise<void>,
  ): Promise<string | undefined> => {
    if (process.env.DEBUG_OPENCODE) {
      log.debug('Event received', { type: event.type });
    }
    const payload = getPayload(event as unknown as Record<string, unknown>);
    const part = (payload.part ?? {}) as { type?: string; messageID?: string; text?: string };

    if (event.type === 'message.part.updated' && part.type === 'text') {
      lastMessage = { messageID: part.messageID ?? null, text: part.text ?? null };
      if (process.env.DEBUG_OPENCODE) {
        log.debug('Message saved for idle summary', {
          messageID: lastMessage.messageID,
          textLength: lastMessage.text?.length,
        });
      }
    }

    // V2 text streaming events (best-effort summary tracking)
    if (
      (event.type === 'session.text.ended' || event.type === 'session.text.delta') &&
      typeof (payload as { text?: unknown }).text === 'string'
    ) {
      lastMessage = {
        messageID: (payload.messageID as string) ?? null,
        text: payload.text as string,
      };
    }
    if (
      event.type === 'session.message.content.updated' &&
      typeof (payload as { text?: unknown }).text === 'string'
    ) {
      lastMessage = {
        messageID: (payload.messageID as string) ?? null,
        text: payload.text as string,
      };
    }

    if (
      pluginConfig.suppressDuringSubagent &&
      event.type === 'message.part.updated' &&
      part.type === 'subtask'
    ) {
      subtasksRunning++;
      if (subtaskTimer) clearTimeout(subtaskTimer);
      subtaskTimer = setTimeout(() => {
        subtasksRunning = 0;
        subtaskTimer = null;
      }, SUBTASK_TIMEOUT_MS);
      await debugLogFile('subtask started, suppressing idle sound', { subtasksRunning });
      if (process.env.DEBUG_OPENCODE) {
        log.debug('Subtask started, suppressing idle sound', { subtasksRunning });
      }
    }

    const status = (payload.status ?? {}) as { type?: string };
    if (
      pluginConfig.suppressDuringSubagent &&
      event.type === 'session.status' &&
      status.type === 'idle' &&
      subtasksRunning > 0
    ) {
      subtasksRunning = Math.max(0, subtasksRunning - 1);
      await debugLogFile('subtask finished, decremented counter', { subtasksRunning });
      if (process.env.DEBUG_OPENCODE) {
        log.debug('Session idle, decremented subtask counter', { subtasksRunning });
      }
      return undefined;
    }

    if (
      event.type === 'session.idle' ||
      event.type === 'session.execution.succeeded' ||
      event.type === 'session.execution.failed' ||
      event.type === 'session.execution.interrupted'
    ) {
      if (pluginConfig.suppressDuringSubagent && subtasksRunning > 0) {
        await debugLogFile('suppressed sound during subagent execution', {
          type: event.type,
          subtasksRunning,
        });
        if (process.env.DEBUG_OPENCODE) {
          log.debug('Suppressing idle sound during subagent execution', { subtasksRunning });
        }
        return undefined;
      }
      const sessionID =
        (getPayload(event as unknown as Record<string, unknown>).sessionID as string) ?? 'unknown';
      if (pluginConfig.suppressDuringSubagent && sessionID !== 'unknown') {
        try {
          if (hooks?.isSubagentSession && (await hooks.isSubagentSession(sessionID))) {
            await debugLogFile('suppressed sound for subagent session', {
              type: event.type,
              sessionID,
            });
            return undefined;
          }
        } catch (err) {
          await debugLogFile('subagent session check failed, playing anyway', {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const now = Date.now();
      if (now - (lastPlayedBySession.get(sessionID) ?? 0) < PLAY_DEBOUNCE_MS) {
        if (process.env.DEBUG_OPENCODE) {
          log.debug('Skipping duplicate idle sound', { sessionID });
        }
        return undefined;
      }
      lastPlayedBySession.set(sessionID, now);
      const summary = getIdleSummary(lastMessage?.text) ?? 'Idle';
      await handleSessionIdle(summary, notify, notifyMissing);
      return summary;
    }
    return undefined;
  };

  const dispose = () => {
    if (subtaskTimer) clearTimeout(subtaskTimer);
    subtaskTimer = null;
  };

  return { handleEvent, handleSessionIdle, dispose, getLastMessage: () => lastMessage };
};

/**
 * Notification idle plugin (V1 entrypoint).
 *
 * Kept for OpenCode V1 (`plugin: [...]` in `opencode.json`). The V2 entrypoint
 * below is used by OpenCode V2 (`plugins: [...]`).
 */
export const NotificationPlugin: V1Plugin = async (ctx) => {
  const { project: _project, client, worktree: _worktree } = ctx;
  void _project;
  void _worktree;

  const pluginConfig = await resolvePluginConfig();

  try {
    const installedCount = await installBundledSoundsIfMissing(pluginConfig.soundsDir);
    if (installedCount > 0) {
      try {
        await client.tui.showToast({
          body: {
            title: 'Warcraft Sounds',
            message: `Installed ${installedCount} sound file${installedCount > 1 ? 's' : ''} successfully`,
            variant: 'success',
            duration: TOAST_DURATION.SUCCESS,
          },
        });
      } catch (toastErr) {
        if (process.env.DEBUG_OPENCODE) log.debug('Toast notification failed', { error: toastErr });
      }
    }
  } catch (err) {
    if (process.env.DEBUG_OPENCODE)
      log.warn('installBundledSoundsIfMissing failed', { error: err });
    try {
      await client.tui.showToast({
        body: {
          title: 'Warcraft Sounds',
          message: 'Failed to install sound files. Using system sounds as fallback.',
          variant: 'warning',
          duration: TOAST_DURATION.WARNING,
        },
      });
    } catch (toastErr) {
      if (process.env.DEBUG_OPENCODE) log.debug('Toast notification failed', { error: toastErr });
    }
  }

  const idle = createIdleHandler(pluginConfig);
  const notifiedMissing = new Set<string>();

  return {
    event: async ({ event }) => {
      await idle.handleEvent(
        event as { type: string; properties?: unknown },
        async (title, message) => {
          try {
            await client.tui.showToast({
              body: { title, message, variant: 'info', duration: TOAST_DURATION.INFO },
            });
          } catch (toastErr) {
            if (process.env.DEBUG_OPENCODE)
              log.error('Toast notification failed', { error: toastErr });
          }
        },
        async (filename) => {
          if (notifiedMissing.has(CACHE_KEY_NOTIFIED_MISSING)) return;
          notifiedMissing.add(CACHE_KEY_NOTIFIED_MISSING);
          try {
            await client.tui.showToast({
              body: {
                title: 'Warcraft Sounds',
                message: `Sound file not found: ${filename}. Using system sound as fallback.`,
                variant: 'info',
                duration: TOAST_DURATION.INFO,
              },
            });
          } catch (toastErr) {
            if (process.env.DEBUG_OPENCODE)
              log.debug('Toast notification failed', { error: toastErr });
          }
        },
      );
    },
    dispose: async () => {
      idle.dispose();
    },
  };
};

/**
 * Notification idle plugin (V2 entrypoint).
 *
 * - Options come from `ctx.options` (object form in `opencode.json`), with
 *   legacy `plugin.json` as fallback.
 * - Events arrive via `ctx.event.subscribe()`; cleanup aborts the stream.
 * - Sound playback uses `node:child_process` (the V1 `$` helper is gone).
 * - Toasts are a TUI concern in V2 — see `src/tui.ts`. The server logs
 *   install/idle activity to stdout/stderr instead of `client.tui.showToast`.
 */
const WarcraftNotificationsV2 = V2Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const pluginConfig = await resolvePluginConfig(ctx.options);
    await debugLogFile('setup', {
      options: ctx.options,
      directory: ctx.location.directory,
      project: ctx.location.project.id,
    });
    if (process.env.DEBUG_OPENCODE) {
      log.debug('Loaded warcraft notifications', {
        directory: ctx.location.directory,
        project: ctx.location.project.id,
      });
    }

    try {
      const installedCount = await installBundledSoundsIfMissing(pluginConfig.soundsDir);
      if (installedCount > 0) {
        console.log(
          `[warcraft-notifications] Installed ${installedCount} sound file${installedCount > 1 ? 's' : ''} successfully`,
        );
      }
    } catch (err) {
      if (process.env.DEBUG_OPENCODE)
        log.warn('installBundledSoundsIfMissing failed', { error: err });
      console.log(
        '[warcraft-notifications] Failed to install sound files. Using system sounds as fallback.',
      );
    }

    const parentCache = new Map<string, boolean>();
    const idle = createIdleHandler(pluginConfig, {
      // V2 subagent guard: child sessions carry `parentID`, so each
      // subagent completion can be skipped while the parent's final
      // completion still plays. Fail-open: on lookup failure, play.
      isSubagentSession: async (sessionID: string) => {
        const cached = parentCache.get(sessionID);
        if (cached !== undefined) return cached;
        const info = (await withTimeout(
          ctx.session.get({ sessionID }) as unknown as Promise<{ parentID?: string | null }>,
          5000,
        )) as { parentID?: string | null };
        const isChild = !!info?.parentID;
        parentCache.set(sessionID, isChild);
        return isChild;
      },
    });
    const controller = new AbortController();
    let notifiedMissing = false;

    const noToast = async () => undefined;
    const logMissing = async (filename: string) => {
      if (notifiedMissing) return;
      notifiedMissing = true;
      log.warn('Sound file not found, using system sound as fallback', { filename });
    };

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const typed = event as unknown as {
              type: string;
              properties?: unknown;
              data?: unknown;
            };
            if (
              typed.type === 'session.idle' ||
              typed.type === 'session.status' ||
              typed.type === 'session.execution.succeeded' ||
              typed.type === 'session.execution.failed' ||
              typed.type === 'session.execution.interrupted'
            ) {
              await debugLogFile('event received', { type: typed.type });
            }
            // Enrich idle summary from session history when available (best-effort).
            if (
              typed.type === 'session.idle' ||
              typed.type === 'session.execution.succeeded' ||
              typed.type === 'session.execution.failed' ||
              typed.type === 'session.execution.interrupted'
            ) {
              const payload = getPayload(typed as unknown as Record<string, unknown>);
              const sessionID = payload.sessionID as string | undefined;
              if (sessionID) {
                try {
                  const messages = (await withTimeout(
                    ctx.session.context({ sessionID }),
                    5000,
                  )) as unknown as Array<{
                    info?: { role?: string };
                    parts?: Array<{ type?: string; text?: string }>;
                  }>;
                  const lastAssistant = [...messages]
                    .reverse()
                    .find((m) => m.info?.role === 'assistant');
                  const textPart = lastAssistant?.parts?.find(
                    (p) => p.type === 'text' && typeof p.text === 'string',
                  );
                  if (textPart?.text) {
                    await idle.handleEvent(
                      {
                        type: 'message.part.updated',
                        properties: { part: { type: 'text', text: textPart.text } },
                      },
                      noToast,
                      logMissing,
                    );
                  }
                } catch (err) {
                  await debugLogFile('session.context enrichment failed', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  // Fall back to tracked lastMessage
                }
              }
            }
            await idle.handleEvent(typed, noToast, logMissing);
          } catch (err) {
            log.error('Failed to handle event', { error: err });
            await debugLogFile('event handler error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        if (!controller.signal.aborted && process.env.DEBUG_OPENCODE) {
          log.debug('Event subscription ended', { error: err });
        }
      }
    })();

    return () => {
      controller.abort();
      idle.dispose();
    };
  },
});

export default {
  ...WarcraftNotificationsV2,
  // V1 object entrypoint (OpenCode >= 1.18.29 also accepts this shape).
  async server(...args: Parameters<V1Plugin>) {
    return await NotificationPlugin(...args);
  },
};

// Also see:
// https://opencode.ai/v2/docs/build/plugins/
// https://opencode.ai/v2/docs/build/plugins/migrate-v1
