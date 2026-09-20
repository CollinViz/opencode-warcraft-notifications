import { Plugin } from '@opencode/plugin/tui';
import { getSoundDescription } from './sounds/descriptions.js';
import { getIdleSummary } from './notification-utils.js';

/**
 * Warcraft notifications TUI plugin (OpenCode V2).
 *
 * Server plugins can no longer call `client.tui.showToast`, so toasts live
 * here: the TUI shows a toast when a session goes idle. Sound playback stays
 * on the server entrypoint (`src/notification.ts`), which runs even headless.
 */
export default Plugin.define({
  id: 'warcraft-notifications',
  setup(context) {
    const showToast = (
      title: string,
      message: string,
      variant: 'info' | 'success' | 'warning' | 'error' = 'info',
      duration = 4000,
    ) => {
      try {
        context.ui.toast.show({ title, message, variant, duration });
      } catch (err) {
        if (process.env.DEBUG_OPENCODE) console.log('[warcraft-notifications] toast failed', err);
      }
    };

    const summarizeSession = (sessionID: string): string => {
      try {
        const messages = (context.data.session.message.list(sessionID) ?? []) as Array<{
          info?: { role?: string };
          parts?: Array<{ type?: string; text?: unknown }>;
        }>;
        const lastAssistant = [...messages].reverse().find((m) => m.info?.role === 'assistant');
        const textPart = lastAssistant?.parts?.find(
          (p) => p.type === 'text' && typeof p.text === 'string',
        );
        const text = typeof textPart?.text === 'string' ? textPart.text : '';
        return getIdleSummary(text) ?? 'Idle';
      } catch {
        return 'Idle';
      }
    };

    const lastToastBySession = new Map<string, number>();

    const isSubagentSession = (sessionID: string): boolean => {
      try {
        const info = context.data.session.get(sessionID) as
          | { parentID?: string | null }
          | undefined;
        return !!info?.parentID;
      } catch {
        return false;
      }
    };

    const handleCompletion = (sessionID: string) => {
      try {
        // One toast per completed unit of work: subagent (child) sessions
        // stay quiet, the parent's completion still notifies.
        if (isSubagentSession(sessionID)) return;
        const now = Date.now();
        if (now - (lastToastBySession.get(sessionID) ?? 0) < 15_000) return;
        lastToastBySession.set(sessionID, now);
        const summary = summarizeSession(sessionID);
        // Title uses a generic label: the exact sound file is chosen
        // server-side, so the TUI does not guess a voice line here.
        // Keep the description lookup for future use (e.g. if the server
        // communicates the chosen file via RPC/storage).
        void getSoundDescription;
        showToast('opencode', summary, 'info', 4000);
      } catch (err) {
        if (process.env.DEBUG_OPENCODE)
          console.log('[warcraft-notifications] idle handler failed', err);
      }
    };

    const offIdle = context.data.on('session.idle', (event) => {
      handleCompletion(event.data.sessionID as string);
    });
    const offSucceeded = context.data.on('session.execution.succeeded', (event) => {
      handleCompletion((event.data as { sessionID: string }).sessionID as string);
    });

    return () => {
      offIdle();
      offSucceeded();
    };
  },
});
