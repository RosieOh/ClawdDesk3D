// Voice lab client: speaks through the local voice-lab server (a voice cloned from your own recording),
// when the bridge reports it running. English only (the model's languages); everything else uses the browser's voice.

import { decodeResponse, enqueue } from './player';

const LAB_URL: string = (import.meta.env.VITE_VOICE_LAB_URL as string | undefined) ?? 'http://127.0.0.1:3003';

/** Queue a line in the cloned voice. `fallback` runs if generation or playback fails. */
export function speakLab(text: string, fallback: () => void) {
  enqueue(
    () =>
      fetch(`${LAB_URL}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }).then((r) => decodeResponse(r, 'voice lab')),
    1,
    `lab: ${text}`,
    fallback,
  );
}
