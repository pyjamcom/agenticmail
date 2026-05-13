import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readClaudeConfig,
  writeClaudeConfig,
  upsertMcpServer,
  removeMcpServer,
} from '../claude-config.js';

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amcc-cfg-'));
  configPath = join(dir, '.claude.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readClaudeConfig', () => {
  it('returns {} for a missing file', () => {
    expect(readClaudeConfig(configPath)).toEqual({});
  });

  it('returns {} for an empty file', () => {
    writeFileSync(configPath, '', 'utf-8');
    expect(readClaudeConfig(configPath)).toEqual({});
  });

  it('throws a clear error for malformed JSON', () => {
    writeFileSync(configPath, '{not json', 'utf-8');
    expect(() => readClaudeConfig(configPath)).toThrow(/Could not parse/);
  });

  it('returns the parsed object for valid JSON', () => {
    writeFileSync(configPath, JSON.stringify({ userID: 'abc', mcpServers: { x: { command: 'y' } } }), 'utf-8');
    const cfg = readClaudeConfig(configPath);
    expect(cfg.userID).toBe('abc');
    expect(cfg.mcpServers).toEqual({ x: { command: 'y' } });
  });
});

describe('upsertMcpServer', () => {
  it('creates a new file with the server block when none exists', () => {
    const changed = upsertMcpServer(configPath, 'agenticmail', { command: 'npx', args: ['-y', '@agenticmail/mcp'] });
    expect(changed).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcpServers.agenticmail.command).toBe('npx');
  });

  it('is idempotent on identical content', () => {
    const entry = { command: 'npx', args: ['-y', '@agenticmail/mcp'] };
    upsertMcpServer(configPath, 'agenticmail', entry);
    const changed = upsertMcpServer(configPath, 'agenticmail', entry);
    expect(changed).toBe(false);
  });

  it('preserves unrelated top-level keys', () => {
    writeFileSync(configPath, JSON.stringify({ userID: 'keep-me', theme: 'dark' }), 'utf-8');
    upsertMcpServer(configPath, 'agenticmail', { command: 'npx' });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.userID).toBe('keep-me');
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers.agenticmail.command).toBe('npx');
  });

  it('preserves unrelated MCP servers', () => {
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { other: { command: 'do-not-touch' } },
    }), 'utf-8');
    upsertMcpServer(configPath, 'agenticmail', { command: 'npx' });
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcpServers.other.command).toBe('do-not-touch');
    expect(cfg.mcpServers.agenticmail.command).toBe('npx');
  });

  it('replaces the existing entry when content differs', () => {
    upsertMcpServer(configPath, 'agenticmail', { command: 'old' });
    const changed = upsertMcpServer(configPath, 'agenticmail', { command: 'new' });
    expect(changed).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.mcpServers.agenticmail.command).toBe('new');
  });
});

describe('removeMcpServer', () => {
  it('returns false when nothing to remove', () => {
    expect(removeMcpServer(configPath, 'agenticmail')).toBe(false);
  });

  it('removes only the named entry', () => {
    writeFileSync(configPath, JSON.stringify({
      userID: 'keep',
      mcpServers: { agenticmail: { command: 'x' }, other: { command: 'y' } },
    }), 'utf-8');
    const changed = removeMcpServer(configPath, 'agenticmail');
    expect(changed).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.userID).toBe('keep');
    expect(cfg.mcpServers.agenticmail).toBeUndefined();
    expect(cfg.mcpServers.other.command).toBe('y');
  });
});

describe('writeClaudeConfig atomicity', () => {
  it('does not leave a stale .tmp file', () => {
    writeClaudeConfig(configPath, { foo: 'bar' });
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const files = readdirSync(dir);
    expect(files.filter(f => f.endsWith('.agenticmail-tmp'))).toEqual([]);
  });
});
