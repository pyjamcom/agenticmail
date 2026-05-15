/**
 * Tests for the ~/.codex/hooks.json patcher.
 *
 * Two invariants to defend:
 *   - We register on SessionStart, UserPromptSubmit, and Stop (and only those).
 *   - We don't disturb hooks the user has installed under the same events.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertMailHook, removeMailHook } from '../codex-hooks-config.js';

let dir: string;
let hooksPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-hooks-'));
  hooksPath = join(dir, 'hooks.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readJson(): { hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>> } {
  return JSON.parse(readFileSync(hooksPath, 'utf-8'));
}

describe('upsertMailHook', () => {
  it('registers on SessionStart + UserPromptSubmit + Stop on a fresh file', () => {
    const changed = upsertMailHook(hooksPath, 'agenticmail-codex-mail-hook');
    expect(changed).toBe(true);
    expect(existsSync(hooksPath)).toBe(true);
    const data = readJson();
    expect(data.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toBe('agenticmail-codex-mail-hook');
    expect(data.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe('agenticmail-codex-mail-hook');
    expect(data.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe('agenticmail-codex-mail-hook');
    // PreToolUse / PermissionRequest etc. should NOT be touched.
    expect(data.hooks?.PreToolUse).toBeUndefined();
    expect(data.hooks?.PermissionRequest).toBeUndefined();
  });

  it('is idempotent — second upsert returns false', () => {
    upsertMailHook(hooksPath, 'agenticmail-codex-mail-hook');
    expect(upsertMailHook(hooksPath, 'agenticmail-codex-mail-hook')).toBe(false);
  });

  it('replaces an earlier-version command on the same event', () => {
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'agenticmail-codex-mail-hook' }] },
        ],
      },
    }));
    const newCmd = 'node "/abs/path/mail-hook.js"';
    expect(upsertMailHook(hooksPath, newCmd)).toBe(true);
    const data = readJson();
    expect(data.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(data.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe(newCmd);
  });

  it("does NOT disturb other hooks the user has installed", () => {
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: 'my-custom-hook.sh' }] },
        ],
      },
    }));
    upsertMailHook(hooksPath, 'agenticmail-codex-mail-hook');
    const data = readJson();
    expect(data.hooks?.UserPromptSubmit).toHaveLength(2);
    expect(data.hooks?.UserPromptSubmit?.map(r => r.hooks[0].command)).toContain('my-custom-hook.sh');
    expect(data.hooks?.UserPromptSubmit?.map(r => r.hooks[0].command)).toContain('agenticmail-codex-mail-hook');
  });

  it('refuses to overwrite a corrupted hooks.json', () => {
    writeFileSync(hooksPath, '{not valid json');
    expect(() => upsertMailHook(hooksPath, 'cmd')).toThrow(/Could not parse Codex hooks/);
  });
});

describe('removeMailHook', () => {
  it('removes from every registered event', () => {
    upsertMailHook(hooksPath, 'agenticmail-codex-mail-hook');
    expect(removeMailHook(hooksPath)).toBe(true);
    const data = readJson();
    expect(data.hooks).toBeUndefined();
  });

  it('returns false when file is missing', () => {
    expect(removeMailHook(hooksPath)).toBe(false);
  });

  it("preserves other users' hooks", () => {
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: 'my-custom-hook.sh' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'agenticmail-codex-mail-hook' }] },
        ],
      },
    }));
    expect(removeMailHook(hooksPath)).toBe(true);
    const data = readJson();
    expect(data.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(data.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe('my-custom-hook.sh');
  });
});
