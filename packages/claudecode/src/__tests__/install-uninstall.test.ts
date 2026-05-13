/**
 * End-to-end-ish tests for install / uninstall / status that stub the
 * AgenticMail API with `vi.fn()` instead of actually hitting the server.
 *
 * Filesystem effects ARE real — we write into a tempdir and verify the
 * resulting files. This is the most valuable place to use real I/O because
 * the package's whole job is "write files into the user's home dir without
 * blowing up adjacent state."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set up the mocked module via vi.hoisted so the factory body is evaluated
// in the same hoisted block as vi.mock itself. Without this, vitest's AST
// transform produces a temporal-dead-zone reference to the mocked module
// (the install/uninstall/status imports below resolve before the mock
// factory can finish initialising).
const apiMocks = vi.hoisted(() => ({
  AgenticMailApiError: function AgenticMailApiError(this: any, status: number, message: string) {
    Error.call(this, message);
    this.status = status;
    this.message = message;
    this.name = 'AgenticMailApiError';
  },
  checkApiHealth: vi.fn(),
  listAccounts: vi.fn(),
  getAccountByName: vi.fn(),
  ensureAccount: vi.fn(),
  deleteAccount: vi.fn(),
}));
vi.mock('../api.js', () => apiMocks);

// Mock PM2 — the install/uninstall path tries to start/stop the dispatcher
// daemon via shell-outs to `pm2`. In tests we don't want to actually start
// a daemon, AND running spawnSync('pm2', ['--version']) is ~400ms even
// when it fails. Stub it out completely; we cover PM2 logic in pm2.test.ts.
vi.mock('../pm2.js', () => ({
  DISPATCHER_PM2_NAME: 'agenticmail-claudecode-dispatcher',
  pm2Available: vi.fn(() => false),
  getDispatcherStatus: vi.fn(() => null),
  startDispatcher: vi.fn(() => ({ started: false, reason: 'pm2 mocked in tests' })),
  stopDispatcher: vi.fn(() => ({ stopped: false })),
}));

import * as api from '../api.js';
import { install } from '../install.js';
import { uninstall } from '../uninstall.js';
import { status } from '../status.js';
import { MANAGED_BY_MARKER } from '../subagent-template.js';

let dir: string;
let amCfgPath: string;
let claudeCfgPath: string;
let agentsDir: string;

const BRIDGE = { id: 'bridge-id', name: 'claudecode', email: 'claudecode@localhost', apiKey: 'ak_bridge' };
const FOLA = { id: 'fola-id', name: 'Fola', email: 'fola@localhost', apiKey: 'ak_fola', role: 'secretary', metadata: { ownerName: 'Ope' } };
const WRITER = { id: 'writer-id', name: 'writer', email: 'writer@localhost', apiKey: 'ak_writer', role: 'writer' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amcc-iu-'));
  amCfgPath = join(dir, 'agenticmail.json');
  claudeCfgPath = join(dir, '.claude.json');
  agentsDir = join(dir, 'agents');
  writeFileSync(amCfgPath, JSON.stringify({ masterKey: 'mk_test', api: { port: 3200, host: '127.0.0.1' } }), 'utf-8');

  vi.mocked(api.checkApiHealth).mockResolvedValue({ ok: true, version: 'test' });
  vi.mocked(api.deleteAccount).mockResolvedValue(undefined);
  vi.mocked(api.ensureAccount).mockResolvedValue(BRIDGE as any);
  vi.mocked(api.listAccounts).mockResolvedValue([BRIDGE, FOLA, WRITER] as any);
  vi.mocked(api.getAccountByName).mockImplementation(async (_u, _k, name) => {
    if (name === 'claudecode') return BRIDGE as any;
    if (name.toLowerCase() === 'fola') return FOLA as any;
    return null;
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('install', () => {
  it('writes the MCP server block and one .md per exposable agent', async () => {
    const result = await install({
      agenticmailConfigPath: amCfgPath,
      claudeConfigPath: claudeCfgPath,
      agentsDir,
    });
    expect(result.changed).toBe(true);
    expect(result.bridgeAgent.name).toBe('claudecode');

    const claudeCfg = JSON.parse(readFileSync(claudeCfgPath, 'utf-8'));
    expect(claudeCfg.mcpServers.agenticmail.command).toBe('npx');
    expect(claudeCfg.mcpServers.agenticmail.env.AGENTICMAIL_API_KEY).toBe('ak_bridge');
    expect(claudeCfg.mcpServers.agenticmail.env.AGENTICMAIL_MASTER_KEY).toBe('mk_test');

    const files = readdirSync(agentsDir);
    expect(files).toContain('agenticmail-fola.md');
    expect(files).toContain('agenticmail-writer.md');
    expect(files).not.toContain('agenticmail-claudecode.md'); // bridge is excluded
  });

  it('seeds AGENTICMAIL_ACCOUNT_KEYS_JSON with every exposable agent (+ the bridge)', async () => {
    await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    const cfg = JSON.parse(readFileSync(claudeCfgPath, 'utf-8'));
    const raw = cfg.mcpServers.agenticmail.env.AGENTICMAIL_ACCOUNT_KEYS_JSON;
    expect(typeof raw).toBe('string');
    const keys = JSON.parse(raw);
    expect(keys.Fola).toBe('ak_fola');
    expect(keys.writer).toBe('ak_writer');
    expect(keys.claudecode).toBe('ak_bridge');
  });

  it('is idempotent — second run with no changes makes no file writes', async () => {
    await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    const second = await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    expect(second.changed).toBe(false);
  });

  it('prunes a stale subagent file when its target agent disappears', async () => {
    await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    expect(readdirSync(agentsDir)).toContain('agenticmail-writer.md');

    // simulate writer being deleted upstream
    vi.mocked(api.listAccounts).mockResolvedValue([BRIDGE, FOLA] as any);
    const result = await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    expect(result.changed).toBe(true);
    expect(readdirSync(agentsDir)).not.toContain('agenticmail-writer.md');
    expect(readdirSync(agentsDir)).toContain('agenticmail-fola.md');
  });

  it('refuses to overwrite a user-authored .md with the same name', async () => {
    mkdirSync(agentsDir, { recursive: true });
    const userFile = join(agentsDir, 'agenticmail-fola.md');
    writeFileSync(userFile, '---\nname: agenticmail-fola\n---\nUser owns this.', 'utf-8');
    await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    const content = readFileSync(userFile, 'utf-8');
    expect(content).toBe('---\nname: agenticmail-fola\n---\nUser owns this.');
  });

  it('preserves unrelated keys in ~/.claude.json', async () => {
    writeFileSync(claudeCfgPath, JSON.stringify({ userID: 'abc', mcpServers: { other: { command: 'keep' } } }), 'utf-8');
    await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    const cfg = JSON.parse(readFileSync(claudeCfgPath, 'utf-8'));
    expect(cfg.userID).toBe('abc');
    expect(cfg.mcpServers.other.command).toBe('keep');
    expect(cfg.mcpServers.agenticmail).toBeDefined();
  });
});

describe('uninstall', () => {
  it('removes only the agenticmail block + owned .md files', async () => {
    await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    // add an unrelated server to verify we don't touch it
    const beforeCfg = JSON.parse(readFileSync(claudeCfgPath, 'utf-8'));
    beforeCfg.mcpServers.other = { command: 'keep' };
    writeFileSync(claudeCfgPath, JSON.stringify(beforeCfg, null, 2), 'utf-8');
    // add a hand-authored md file we should not touch
    const userFile = join(agentsDir, 'my-custom-agent.md');
    writeFileSync(userFile, '---\nname: my-custom-agent\n---\nKeep me.', 'utf-8');

    const result = await uninstall({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    expect(result.changed).toBe(true);
    expect(result.mcpBlockRemoved).toBe(true);
    expect(result.removedSubagents.length).toBeGreaterThan(0);
    expect(result.bridgeAgentDeleted).toBe(false); // not purged by default

    const afterCfg = JSON.parse(readFileSync(claudeCfgPath, 'utf-8'));
    expect(afterCfg.mcpServers.agenticmail).toBeUndefined();
    expect(afterCfg.mcpServers.other.command).toBe('keep');
    expect(existsSync(userFile)).toBe(true);
  });

  it('purgeBridgeAgent calls deleteAccount when set', async () => {
    await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    const result = await uninstall({
      agenticmailConfigPath: amCfgPath,
      claudeConfigPath: claudeCfgPath,
      agentsDir,
      purgeBridgeAgent: true,
    });
    expect(api.deleteAccount).toHaveBeenCalledWith(expect.any(String), expect.any(String), BRIDGE.id);
    expect(result.bridgeAgentDeleted).toBe(true);
  });

  it('returns changed=false on a clean install dir', async () => {
    const result = await uninstall({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    expect(result.changed).toBe(false);
  });
});

describe('status', () => {
  it('reports not_installed on a fresh dir', async () => {
    // Bridge agent must look absent for "not_installed" to be reachable — set the
    // mock first, otherwise we'd be back at "partial" (bridge exists, MCP/subagents don't).
    vi.mocked(api.getAccountByName).mockResolvedValue(null);
    const s = await status({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    expect(s.state).toBe('not_installed');
  });

  it('reports installed after install()', async () => {
    await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    const s = await status({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    expect(s.state).toBe('installed');
    expect(s.mcpInstalled).toBe(true);
    expect(s.bridgeAgentExists).toBe(true);
    expect(s.subagents.length).toBeGreaterThan(0);
  });

  it('reports partial when MCP is registered but bridge agent vanished', async () => {
    await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    vi.mocked(api.getAccountByName).mockResolvedValue(null); // bridge gone
    const s = await status({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    expect(s.state).toBe('partial');
    expect(s.notes.some(n => n.includes('bridge agent'))).toBe(true);
  });

  it('every owned subagent .md contains the managed-by marker', async () => {
    await install({ agenticmailConfigPath: amCfgPath, claudeConfigPath: claudeCfgPath, agentsDir });
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) continue;
      const c = readFileSync(join(agentsDir, file), 'utf-8');
      expect(c).toContain(MANAGED_BY_MARKER);
    }
  });
});
