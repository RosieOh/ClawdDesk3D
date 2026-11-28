import { describe, expect, it } from 'vitest';
import { branchLabel, permissionMode, prettyModel, shortId, sourceLabel, startLabel } from './format';

describe('prettyModel', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['claude-3-5-haiku-20241022', 'Haiku 3.5'],
    ['claude-opus-4-1[1m]', 'Opus 4.1 (1M)'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'Sonnet 4.5'],
    ['claude-fable-5-2', 'Fable 5.2'],
    ['claude-haiku-5', 'Haiku 5'],
  ])('%s → %s', (id, expected) => expect(prettyModel(id)).toBe(expected));

  it('leaves unknown ids alone and handles missing values', () => {
    expect(prettyModel('gpt-x')).toBe('gpt-x');
    expect(prettyModel(null)).toBeNull();
    expect(prettyModel('')).toBeNull();
  });
});

describe('labels', () => {
  it('formats ids, sources, modes, start and branch', () => {
    expect(shortId('8b801177-25f5-4a89-aa76-f7490eaaa2bd')).toBe('8b801177');
    expect(sourceLabel('vscode')).toBe('VS Code');
    expect(sourceLabel('cli')).toBe('CLI');
    expect(sourceLabel('cursor-ish')).toBe('cursor-ish');
    expect(permissionMode('bypassPermissions')?.label).toBe('bypass');
    expect(permissionMode('somethingNew')?.label).toBe('somethingNew');
    expect(permissionMode(undefined)).toBeNull();
    expect(startLabel('resume')).toBe('resumed');
    expect(branchLabel('HEAD')).toBeNull();
    expect(branchLabel('feat/x')).toBe('feat/x');
  });
});
