import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPersonaForAgent } from '../persona-loader.js';
import type { AgenticMailAccount } from '../types.js';

const FOLA: AgenticMailAccount = {
  id: 'fola-id',
  name: 'Fola',
  email: 'fola@localhost',
  apiKey: 'ak_x',
  role: 'secretary',
  metadata: { ownerName: 'Ope' },
};

let dir: string;
let agentsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amcc-persona-'));
  agentsDir = join(dir, 'agents');
  mkdirSync(agentsDir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadPersonaForAgent', () => {
  it('generates a persona from API metadata when no file exists', () => {
    const result = loadPersonaForAgent({
      agent: FOLA,
      agentsDir,
      subagentPrefix: 'agenticmail-',
      mcpServerName: 'agenticmail',
    });
    expect(result.source).toBe('generated');
    expect(result.filePath).toBeUndefined();
    expect(result.body).toContain('You are **Fola**');
    expect(result.body).toContain('fola@localhost');
    expect(result.body).toMatch(/_account: "Fola"/);
  });

  it('reads from disk when the .md file exists, stripping frontmatter', () => {
    const file = join(agentsDir, 'agenticmail-fola.md');
    writeFileSync(file, [
      '---',
      'name: agenticmail-fola',
      'tools: mcp__agenticmail__whoami',
      '---',
      '',
      '# CUSTOM Fola persona',
      '',
      'Operator-edited body here.',
    ].join('\n'), 'utf-8');

    const result = loadPersonaForAgent({
      agent: FOLA,
      agentsDir,
      subagentPrefix: 'agenticmail-',
      mcpServerName: 'agenticmail',
    });
    expect(result.source).toBe('file');
    expect(result.filePath).toBe(file);
    // Frontmatter must be stripped — no leading "---" or "name:".
    expect(result.body).not.toMatch(/^---/);
    expect(result.body).not.toMatch(/^name:/m);
    expect(result.body).toContain('# CUSTOM Fola persona');
    expect(result.body).toContain('Operator-edited body here.');
  });

  it('returns content even when the file has no frontmatter', () => {
    const file = join(agentsDir, 'agenticmail-fola.md');
    writeFileSync(file, 'Just a body, no frontmatter.', 'utf-8');
    const result = loadPersonaForAgent({
      agent: FOLA,
      agentsDir,
      subagentPrefix: 'agenticmail-',
      mcpServerName: 'agenticmail',
    });
    expect(result.source).toBe('file');
    expect(result.body).toBe('Just a body, no frontmatter.');
  });

  it('falls back to generated when the file is empty or whitespace only', () => {
    const file = join(agentsDir, 'agenticmail-fola.md');
    writeFileSync(file, '---\nname: x\n---\n\n   \n   ', 'utf-8');
    const result = loadPersonaForAgent({
      agent: FOLA,
      agentsDir,
      subagentPrefix: 'agenticmail-',
      mcpServerName: 'agenticmail',
    });
    expect(result.source).toBe('generated');
  });

  it('respects the subagent prefix when locating the file', () => {
    const file = join(agentsDir, 'mail-fola.md');
    writeFileSync(file, '---\nname: x\n---\nCUSTOM with custom prefix.', 'utf-8');
    const result = loadPersonaForAgent({
      agent: FOLA,
      agentsDir,
      subagentPrefix: 'mail-',
      mcpServerName: 'agenticmail',
    });
    expect(result.source).toBe('file');
    expect(result.body).toContain('CUSTOM with custom prefix.');
  });

  it('handles CRLF line endings in the file', () => {
    const file = join(agentsDir, 'agenticmail-fola.md');
    writeFileSync(file, '---\r\nname: x\r\n---\r\n\r\nbody', 'utf-8');
    const result = loadPersonaForAgent({
      agent: FOLA,
      agentsDir,
      subagentPrefix: 'agenticmail-',
      mcpServerName: 'agenticmail',
    });
    expect(result.source).toBe('file');
    expect(result.body).toBe('body');
  });
});
