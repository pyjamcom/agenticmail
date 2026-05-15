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

  it('uses sensible defaults for Codex paths', () => {
    // Force CODEX_HOME off so the test asserts against the actual default
    // (the env var leaks in from the user's shell otherwise).
    const prev = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      const cfg = resolveConfig({ agenticmailConfigPath: join(dir, 'none.json') });
      expect(cfg.codexHome).toBe(join(homedir(), '.codex'));
      expect(cfg.codexConfigPath).toBe(join(homedir(), '.codex', 'config.toml'));
      expect(cfg.codexHooksPath).toBe(join(homedir(), '.codex', 'hooks.json'));
      expect(cfg.agentsDir).toBe(join(homedir(), '.codex', 'agents'));
      expect(cfg.mcpServerName).toBe('agenticmail');
      expect(cfg.bridgeAgentName).toBe('codex');
      expect(cfg.subagentPrefix).toBe('agenticmail-');
    } finally {
      if (prev !== undefined) process.env.CODEX_HOME = prev;
    }
  });

  it('honours CODEX_HOME env var', () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/custom/codex/home';
    try {
      const cfg = resolveConfig({ agenticmailConfigPath: join(dir, 'none.json') });
      expect(cfg.codexHome).toBe('/custom/codex/home');
      expect(cfg.codexConfigPath).toBe('/custom/codex/home/config.toml');
      expect(cfg.agentsDir).toBe('/custom/codex/home/agents');
    } finally {
      if (prev !== undefined) process.env.CODEX_HOME = prev;
      else delete process.env.CODEX_HOME;
    }
  });

  it('explicit codexHome option overrides env', () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/from/env';
    try {
      const cfg = resolveConfig({
        agenticmailConfigPath: join(dir, 'none.json'),
        codexHome: '/from/opt',
      });
      expect(cfg.codexHome).toBe('/from/opt');
    } finally {
      if (prev !== undefined) process.env.CODEX_HOME = prev;
      else delete process.env.CODEX_HOME;
    }
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
