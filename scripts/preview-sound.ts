/**
 * Play one random Warcraft sound through the plugin's own playback chain.
 *
 * Fund/model-independent audio check: verifies sound files resolve and the
 * platform player (`paplay`/`aplay`/`afplay`) is invoked successfully.
 *
 * Usage:
 *   bun scripts/preview-sound.ts [alliance|horde|both]
 */
import { getRandomSoundPathFromFaction } from '../src/sounds/index.js';
import { playSoundFile } from '../src/sound-player.js';
import { extractFilename } from '../src/notification-utils.js';
import type { Faction } from '../src/config/index.js';

const faction = (process.argv[2] ?? 'both') as Faction;
if (!['alliance', 'horde', 'both'].includes(faction)) {
  console.error(`Unknown faction: ${faction}. Use alliance, horde, or both.`);
  process.exit(1);
}

const soundPath = getRandomSoundPathFromFaction(faction);
console.log(`Playing ${extractFilename(soundPath)} (${faction})...`);
await playSoundFile(soundPath);
console.log('Done.');
