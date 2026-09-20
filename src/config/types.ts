/**
 * Faction type for Warcraft II sounds
 */
export type Faction = 'alliance' | 'horde' | 'both';

/**
 * Configuration interface for the warcraft notifications plugin
 */
export interface WarcraftNotificationConfig {
  /** Directory where sound files should be stored and cached */
  soundsDir?: string;
  /** Which faction sounds to use: 'alliance', 'horde', or 'both' (default: 'both') */
  faction?: Faction;
  /** Whether to show toast notifications when idle (default: true). When enabled, displays voice lines as toast title */
  showDescriptionInToast?: boolean;
  /** Suppress idle sound when a subagent/subtask is running (default: false) */
  suppressDuringSubagent?: boolean;
  /** Timeout in ms to clear subagent state if no completion signal received (default: 30000, range: 1000-300000) */
  subagentSilenceTimeoutMs?: number;
  /**
   * Write verbose diagnostic lines to a plugin-local debug log file
   * (warcraft-debug.log). Errors are always recorded regardless of this flag;
   * it only gates informational lines such as event receipt and playback.
   * Defaults to true. Set to false to stop file writes. Setting the
   * WARCRAFT_DEBUG_FILE env var forces it on.
   */
  debug?: boolean;
}

/**
 * Plugin configuration file structure
 */
export interface PluginConfig {
  [pluginName: string]: unknown;
}
