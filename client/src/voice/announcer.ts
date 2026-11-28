// Decides what the desk should say, from successive session snapshots. Pure logic: no audio, no DOM.

import type { AgentState, Session } from '../store';

export type Lang = 'ko' | 'en';

export type Announcement =
  | { kind: 'done'; sessionId: string; project: string; durationMs: number }
  | { kind: 'failed'; sessionId: string; project: string }
  | { kind: 'permission'; sessionId: string; project: string; tool: string | null }
  | { kind: 'started'; sessionId: string; project: string }
  | { kind: 'ended'; sessionId: string; project: string };

export interface AnnouncerOptions {
  /** Turns shorter than this finish silently (quick replies don't need a voice). */
  minTurnMs: number;
}

/** Default: only turns that took a while are worth announcing. */
export const DEFAULT_MIN_TURN_MS = 15_000;

const isWorking = (s: AgentState) => s === 'GENERATING' || s === 'TOOL_RUNNING' || s === 'WAITING';

interface Tracked {
  state: AgentState;
  /** when the current turn started (left rest), null while resting */
  turnSince: number | null;
}

export class Announcer {
  private seen = new Map<string, Tracked>();
  private seeded = false;

  /** Forget everything (e.g. after reconnecting): the next snapshot is a fresh baseline. */
  reset() {
    this.seen.clear();
    this.seeded = false;
  }

  update(sessions: Session[], now: number, opts: AnnouncerOptions = { minTurnMs: DEFAULT_MIN_TURN_MS }): Announcement[] {
    const out: Announcement[] = [];
    const present = new Set<string>();

    for (const s of sessions) {
      present.add(s.id);
      const prev = this.seen.get(s.id);
      const base = { sessionId: s.id, project: s.project };

      if (!prev) {
        // The first snapshot is a baseline; sessions that show up later are new.
        if (this.seeded && s.state !== 'OFFLINE') out.push({ kind: 'started', ...base });
        this.seen.set(s.id, { state: s.state, turnSince: isWorking(s.state) ? now : null });
        continue;
      }
      if (prev.state === s.state) continue;

      if (s.state === 'OFFLINE') {
        out.push({ kind: 'ended', ...base });
      } else if (s.state === 'WAITING') {
        out.push({ kind: 'permission', ...base, tool: (s.running ?? 0) > 0 ? (s.lastTool ?? null) : null });
      } else if (s.state === 'IDLE' && isWorking(prev.state)) {
        const durationMs = prev.turnSince == null ? 0 : now - prev.turnSince;
        if (s.lastEvent === 'StopFailure') out.push({ kind: 'failed', ...base });
        else if (durationMs >= opts.minTurnMs) out.push({ kind: 'done', ...base, durationMs });
      }

      const turnSince = isWorking(s.state) ? (prev.turnSince ?? now) : null;
      this.seen.set(s.id, { state: s.state, turnSince });
    }

    for (const id of [...this.seen.keys()]) if (!present.has(id)) this.seen.delete(id);
    this.seeded = true;
    return out;
  }
}

// ---------------------------------------------------------------- status report

const joinNames = (names: string[], lang: Lang) =>
  names.length <= 1 ? (names[0] ?? '') : lang === 'ko' ? names.join(', ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** What JARVIS answers when asked for a status (double clap while awake). */
export function statusReport(sessions: Session[], lang: Lang): string {
  const live = sessions.filter((s) => s.state !== 'OFFLINE');
  const waiting = live.filter((s) => s.state === 'WAITING').map((s) => s.project);
  const working = live.filter((s) => s.state === 'GENERATING' || s.state === 'TOOL_RUNNING').map((s) => s.project);
  const n = live.length;
  if (lang === 'ko') {
    if (n === 0) return '지금 실행 중인 세션이 없습니다.';
    const parts = [`세션 ${n}개가 연결되어 있습니다.`];
    if (waiting.length) parts.push(`${joinNames(waiting, lang)}에서 승인을 기다리고 있습니다.`);
    if (working.length) parts.push(`${joinNames(working, lang)} 작업 중입니다.`);
    if (!waiting.length && !working.length) parts.push('모두 대기 중입니다.');
    return parts.join(' ');
  }
  if (n === 0) return 'All quiet, sir. No sessions are running.';
  const parts = [`Sir, ${n} session${n === 1 ?' is' : 's are'} online.`];
  if (waiting.length) parts.push(`${joinNames(waiting, lang)} ${waiting.length === 1 ? 'is' : 'are'} waiting for your approval.`);
  if (working.length) parts.push(`${joinNames(working, lang)} ${working.length === 1 ? 'is' : 'are'} working.`);
  if (!waiting.length && !working.length) parts.push(n === 1 ? 'It is standing by.' : 'All are standing by.');
  return parts.join(' ');
}

// ---------------------------------------------------------------- phrasing

function minutes(ms: number, lang: Lang): string | null {
  const m = Math.round(ms / 60_000);
  if (m < 1) return null;
  return lang === 'ko' ? `${m}분 걸렸습니다.` : `It took ${m} minute${m === 1 ? '' : 's'}.`;
}

/** What JARVIS says. `withProject` names the project (useful once several sessions are open). */
export function phrase(a: Announcement, lang: Lang, withProject: boolean): string {
  const p = withProject ? a.project : null;
  if (lang === 'ko') {
    switch (a.kind) {
      case 'done': {
        const head = p ? `${p} 작업을 마쳤습니다.` : '작업을 마쳤습니다.';
        return [head, minutes(a.durationMs, lang)].filter(Boolean).join(' ');
      }
      case 'failed':
        return p ? `${p} 작업이 오류로 중단되었습니다.` : '작업이 오류로 중단되었습니다.';
      case 'permission': {
        const what = a.tool ? `${a.tool} 실행 승인이 필요합니다.` : '확인이 필요합니다.';
        return p ? `${p}에서 ${what}` : what;
      }
      case 'started':
        return `${a.project} 세션이 연결되었습니다.`;
      case 'ended':
        return `${a.project} 세션이 종료되었습니다.`;
    }
  }
  // English speaks like a certain British butler AI.
  switch (a.kind) {
    case 'done': {
      const head = p ? `${p} is complete, sir.` : 'Task complete, sir.';
      return [head, minutes(a.durationMs, lang)].filter(Boolean).join(' ');
    }
    case 'failed':
      return p ? `I'm afraid ${p} has stopped with an error, sir.` : "I'm afraid the task has stopped with an error, sir.";
    case 'permission':
      if (p) return a.tool ? `Sir, ${p} requires your authorization to run ${a.tool}.` : `Sir, ${p} requires your attention.`;
      return a.tool ? `Sir, I need your authorization to run ${a.tool}.` : 'Sir, your attention is required.';
    case 'started':
      return `${a.project} is online, sir.`;
    case 'ended':
      return `${a.project} has gone offline, sir.`;
  }
}
