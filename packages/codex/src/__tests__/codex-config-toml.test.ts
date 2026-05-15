/**
 * Tests for the ~/.codex/config.toml patcher.
 *
 * We're paranoid here because partial / corrupt config.toml prevents Codex
 * CLI from starting at all — every public write goes through tmp + rename,
 * and we only ever touch two keys (mcp_servers.<name> and
 * features.multi_agent_v2.enabled).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import {
  readCodexConfig,
  upsertMcpServer,
  removeMcpServer,
  ensureMultiAgentEnabled,
} from '../codex-config-toml.js';

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-toml-'));
  cfgPath = join(dir, 'config.toml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readCodexConfig', () => {
  it('returns {} when file is missing', () => {
    expect(readCodexConfig(cfgPath)).toEqual({});
  });

  it('returns {} when file is empty', () => {
    writeFileSync(cfgPath, '', 'utf-8');
    expect(readCodexConfig(cfgPath)).toEqual({});
  });

  it('parses a valid config.toml', () => {
    writeFileSync(cfgPath, `model = "gpt-5"\n[mcp_servers.agenticmail]\ncommand = "agenticmail-mcp"\n`);
    const cfg = readCodexConfig(cfgPath);
    expect(cfg.mcp_servers?.agenticmail).toEqual({ command: 'agenticmail-mcp' });
    expect((cfg as { model?: string }).model).toBe('gpt-5');
  });

  it('throws with a helpful message on parse failure', () => {
    writeFileSync(cfgPath, 'not = valid = toml\n');
    expect(() => readCodexConfig(cfgPath)).toThrow(/Could not parse Codex config/);
  });
});

describe('upsertMcpServer', () => {
  it('writes the entry to a fresh file', () => {
    const changed = upsertMcpServer(cfgPath, 'agenticmail', {
      command: 'agenticmail-mcp',
      args: [],
      env: { AGENTICMAIL_API_URL: 'http://127.0.0.1:3829' },
      enabled: true,
    });
    expect(changed).toBe(true);
    const reloaded = readCodexConfig(cfgPath);
    expect(reloaded.mcp_servers?.agenticmail).toMatchObject({
      command: 'agenticmail-mcp',
      env: { AGENTICMAIL_API_URL: 'http://127.0.0.1:3829' },
      enabled: true,
    });
  });

  it('is idempotent — no-op when entry already matches', () => {
    const entry = { command: 'agenticmail-mcp', enabled: true };
    expect(upsertMcpServer(cfgPath, 'agenticmail', entry)).toBe(true);
    expect(upsertMcpServer(cfgPath, 'agenticmail', entry)).toBe(false);
  });

  it('preserves OTHER mcp_servers entries (does not clobber)', () => {
    // Pre-populate with a user's existing server.
    writeFileSync(cfgPath, TOML.stringify({
      mcp_servers: {
        github: { command: 'github-mcp', args: [] } as TOML.JsonMap,
        agenticmail: { command: 'old-binary' } as TOML.JsonMap,
      },
    } as TOML.JsonMap));
    upsertMcpServer(cfgPath, 'agenticmail', { command: 'new-binary' });
    const reloaded = readCodexConfig(cfgPath);
    expect(reloaded.mcp_servers?.github).toMatchObject({ command: 'github-mcp' });
    expect(reloaded.mcp_servers?.agenticmail).toMatchObject({ command: 'new-binary' });
  });

  it('preserves OTHER top-level keys (model, sandbox, etc.)', () => {
    writeFileSync(cfgPath, `model = "gpt-5"\nsandbox_mode = "workspace-write"\n`);
    upsertMcpServer(cfgPath, 'agenticmail', { command: 'agenticmail-mcp' });
    const txt = readFileSync(cfgPath, 'utf-8');
    expect(txt).toContain('model');
    expect(txt).toContain('gpt-5');
    expect(txt).toContain('sandbox_mode');
  });
});

describe('removeMcpServer', () => {
  it('returns false when file is missing', () => {
    expect(removeMcpServer(cfgPath, 'agenticmail')).toBe(false);
  });

  it('returns false when entry is absent', () => {
    writeFileSync(cfgPath, `model = "gpt-5"\n`);
    expect(removeMcpServer(cfgPath, 'agenticmail')).toBe(false);
  });

  it('removes the entry and leaves the rest', () => {
    writeFileSync(cfgPath, TOML.stringify({
      mcp_servers: {
        github: { command: 'github-mcp' } as TOML.JsonMap,
        agenticmail: { command: 'agenticmail-mcp' } as TOML.JsonMap,
      },
    } as TOML.JsonMap));
    expect(removeMcpServer(cfgPath, 'agenticmail')).toBe(true);
    const reloaded = readCodexConfig(cfgPath);
    expect(reloaded.mcp_servers?.agenticmail).toBeUndefined();
    expect(reloaded.mcp_servers?.github).toBeDefined();
  });
});

describe('ensureMultiAgentEnabled', () => {
  it('writes the flag on a fresh file', () => {
    expect(ensureMultiAgentEnabled(cfgPath)).toBe(true);
    expect(existsSync(cfgPath)).toBe(true);
    const reloaded = readCodexConfig(cfgPath);
    expect(reloaded.features?.multi_agent_v2?.enabled).toBe(true);
  });

  it('is idempotent when already true', () => {
    expect(ensureMultiAgentEnabled(cfgPath)).toBe(true);
    expect(ensureMultiAgentEnabled(cfgPath)).toBe(false);
  });

  it('preserves other features when flipping multi_agent_v2', () => {
    writeFileSync(cfgPath, `[features.other_flag]\nenabled = true\n`);
    expect(ensureMultiAgentEnabled(cfgPath)).toBe(true);
    const reloaded = readCodexConfig(cfgPath);
    expect((reloaded.features as { other_flag?: { enabled?: boolean } })?.other_flag?.enabled).toBe(true);
    expect(reloaded.features?.multi_agent_v2?.enabled).toBe(true);
  });
});
