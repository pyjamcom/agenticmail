import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../config.js';

let dir: string;
let amCfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amcc-'));
  amCfgPath = join(dir, 'agenticmail.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveConfig', () => {
  it('reads master key and api url from the on-disk AgenticMail config', () => {
    writeFileSync(amCfgPath, JSON.stringify({
      masterKey: 'mk_from_disk',
      api: { port: 4321, host: '0.0.0.0' },
    }), 'utf-8');
    const cfg = resolveConfig({ agenticmailConfigPath: amCfgPath });
    expect(cfg.masterKey).toBe('mk_from_disk');
    expect(cfg.apiUrl).toBe('http://0.0.0.0:4321');
  });

  it('falls back to defaults when no on-disk config', () => {
    const cfg = resolveConfig({ agenticmailConfigPath: join(dir, 'does-not-exist.json') });
    expect(cfg.apiUrl).toBe('http://127.0.0.1:3829');
    expect(cfg.masterKey).toBe('');
  });

  it('explicit options override on-disk config', () => {
    writeFileSync(amCfgPath, JSON.stringify({ masterKey: 'mk_disk', api: { port: 9999 } }), 'utf-8');
    const cfg = resolveConfig({
      agenticmailConfigPath: amCfgPath,
      masterKey: 'mk_explicit',
      apiUrl: 'http://override:1234',
    });
    expect(cfg.masterKey).toBe('mk_explicit');
    expect(cfg.apiUrl).toBe('http://override:1234');
  });

  it('uses sensible defaults for Claude Code paths', () => {
    const cfg = resolveConfig({ agenticmailConfigPath: join(dir, 'none.json') });
    expect(cfg.claudeConfigPath).toBe(join(homedir(), '.claude.json'));
    expect(cfg.agentsDir).toBe(join(homedir(), '.claude', 'agents'));
    expect(cfg.mcpServerName).toBe('agenticmail');
    expect(cfg.bridgeAgentName).toBe('claudecode');
    expect(cfg.subagentPrefix).toBe('agenticmail-');
  });

  it('uses npx as the default MCP command (portability over speed)', () => {
    const cfg = resolveConfig({ agenticmailConfigPath: join(dir, 'none.json') });
    expect(cfg.mcpCommand).toBe('npx');
    expect(cfg.mcpArgs).toEqual(['-y', '@agenticmail/mcp']);
  });

  it('tolerates malformed on-disk AgenticMail config (returns defaults)', () => {
    writeFileSync(amCfgPath, '{not json', 'utf-8');
    const cfg = resolveConfig({ agenticmailConfigPath: amCfgPath });
    expect(cfg.masterKey).toBe('');
    expect(cfg.apiUrl).toBe('http://127.0.0.1:3829');
  });
});
