// What a spoken command means. Pure: text in, intent out.
//
// A few things are handled on the desk directly (status, quiet, never mind); anything else is a task
// for Claude, sent to the session the desk is showing.

export type Intent =
  | { kind: 'none' }
  | { kind: 'status' }
  | { kind: 'mute' }
  | { kind: 'cancel' }
  | { kind: 'claude'; prompt: string };

/** "Jarvis, …", "Hey Jarvis …", "자비스, …" are just how you address it. */
const WAKE = /^\s*(?:(?:hey|ok|okay|hi)\s+)?(?:jarvis|자비스|쟈비스)[\s,.!?:~-]*/i;

const STATUS = [
  /^(?:what(?:'s| is) the )?status\??$/i,
  /^(?:how(?:'s| is| are) (?:it|things|everything) going|what(?:'s| is) going on|report)\??$/i,
  /^(?:상태|상태 (?:알려 ?줘|보고|어때)|지금 (?:상황|상태)(?:은| 어때| 알려 ?줘)?|보고해 ?줘?)[?.]?$/,
];
const MUTE = [/^(?:be quiet|quiet|mute|silence|stop talking|shut up)[.!]?$/i, /^(?:조용히(?: 해 ?줘?)?|음소거|그만 말해)[.!]?$/];
const CANCEL = [/^(?:never ?mind|cancel|forget it|nothing)[.!]?$/i, /^(?:취소|아니야|됐어|아무것도 아니야)[.!]?$/];

export function stripWake(text: string): string {
  return text.replace(WAKE, '').trim();
}

export function parseIntent(raw: string): Intent {
  const text = stripWake(raw.trim()).replace(/\s+/g, ' ');
  if (!text) return { kind: 'none' };
  const plain = text.replace(/[.!?。]+$/u, '').trim();
  if (STATUS.some((r) => r.test(plain))) return { kind: 'status' };
  if (MUTE.some((r) => r.test(plain))) return { kind: 'mute' };
  if (CANCEL.some((r) => r.test(plain))) return { kind: 'cancel' };
  // Whisper sometimes hears room noise as a word or two of filler; don't send that to Claude.
  if (plain.length < 4 || /^(?:thank you|thanks|you|uh|um|음|어)$/i.test(plain)) return { kind: 'none' };
  return { kind: 'claude', prompt: text };
}

/** The first sentence or so of Claude's answer, for speaking aloud (the caption shows more). */
export function spokenSummary(result: string, max = 220): string {
  const clean = result
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('다. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}
