// Display helpers for session details.

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * `claude-opus-5-5` → `Opus 5.5`, `claude-sonnet-4-5-20250929` → `Sonnet 4.5`,
 * `claude-3-5-haiku-20241022` → `Haiku 3.5`, `claude-opus-4-1[1m]` → `Opus 4.1 (1M)`.
 * Anything unrecognised is returned as is.
 */
export function prettyModel(id: string | null | undefined): string | null {
  if (!id) return null;
  const ctx = /\[(\d+[km])\]$/i.exec(id)?.[1]?.toUpperCase();
  const parts = id
    .replace(/\[.*\]$/, '')
    .toLowerCase()
    .replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '')
    .replace(/^claude-/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .split('-')
    .filter((p) => !/^\d{8}$/.test(p)); // drop date stamps
  const family = parts.find((p) => FAMILIES.includes(p));
  if (!family) return id;
  const version = parts.filter((p) => /^\d+$/.test(p) && p.length <= 2).join('.');
  const name = family[0].toUpperCase() + family.slice(1);
  return [name, version, ctx ? `(${ctx})` : ''].filter(Boolean).join(' ');
}

export const shortId = (id: string) => id.slice(0, 8);

/** 950 → "950", 12_345 → "12.3k", 4_200_000 → "4.2M" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, '')}M`;
}

/** Fresh input (incl. cache writes) and output: what a turn actually produced; cache reads shown apart. */
export function tokenLine(u: { input: number; output: number; cacheRead: number; cacheWrite: number } | null | undefined): string | null {
  if (!u) return null;
  return `↑${formatTokens(u.input + u.cacheWrite)} ↓${formatTokens(u.output)} · cache ${formatTokens(u.cacheRead)}`;
}

export function sourceLabel(source: string): string {
  switch (source) {
    case 'vscode':
      return 'VS Code';
    case 'cli':
      return 'CLI';
    case 'jetbrains':
      return 'JetBrains';
    case 'sim':
      return 'Simulator';
    case 'unknown':
      return '—';
    default:
      return source;
  }
}

interface ModeStyle {
  label: string;
  color: string;
}

const MODES: Record<string, ModeStyle> = {
  default: { label: 'ask', color: '#9aa4b2' },
  plan: { label: 'plan', color: '#7aa7ff' },
  acceptEdits: { label: 'accept edits', color: '#34f5a4' },
  auto: { label: 'auto', color: '#ffb35c' },
  dontAsk: { label: "don't ask", color: '#ff9a4d' },
  bypassPermissions: { label: 'bypass', color: '#ff5d6c' },
};

export function permissionMode(mode: string | null | undefined): ModeStyle | null {
  if (!mode) return null;
  return MODES[mode] ?? { label: mode, color: '#9aa4b2' };
}

const START: Record<string, string> = { startup: 'new', resume: 'resumed', clear: 'cleared' };
export const startLabel = (s: string | null | undefined) => (s ? (START[s] ?? s) : null);

/** `HEAD` is what Claude Code records outside a branch (detached or no repo yet); not worth showing. */
export const branchLabel = (b: string | null | undefined) => (b && b !== 'HEAD' ? b : null);
