/**
 * Tests for the Codex agent .toml renderer.
 *
 * Two distinct checks:
 *   1. The output is valid TOML that Codex can load (required keys present,
 *      multi-line strings escape correctly).
 *   2. The persona body carries the host-specific framing (mentions Codex,
 *      not Claude Code) and the right MCP tool names.
 */
import { describe, it, expect } from 'vitest';
import TOML from '@iarna/toml';
import { renderSubagentToml, renderPersonaBody, MANAGED_BY_MARKER } from '../subagent-template.js';
import type { AgenticMailAccount } from '../types.js';

const FIXTURE: AgenticMailAccount = {
  id: 'agt_abc',
  name: 'Vesper',
  email: 'vesper@localhost',
  apiKey: 'ak_xxxx',
  role: 'researcher',
  metadata: { ownerName: 'Ope' },
};

describe('renderSubagentToml', () => {
  it('emits valid TOML with the required Codex agent fields', () => {
    const text = renderSubagentToml({
      name: 'agenticmail-vesper',
      agent: FIXTURE,
      mcpServerName: 'agenticmail',
    });
    // The output starts with our managed-by comment block, then TOML.
    expect(text).toContain(`# managed-by: ${MANAGED_BY_MARKER}`);
    expect(text).toContain('# agenticmail-agent-id: agt_abc');
    // Parse the TOML portion (TOML parser skips comments natively).
    const parsed = TOML.parse(text) as { name?: string; description?: string; developer_instructions?: string };
    expect(parsed.name).toBe('agenticmail-vesper');
    expect(typeof parsed.description).toBe('string');
    expect(typeof parsed.developer_instructions).toBe('string');
    // Codex's loader requires developer_instructions to be present and non-empty.
    expect((parsed.developer_instructions as string).length).toBeGreaterThan(100);
  });

  it('embeds the agent name + email in the persona body', () => {
    const text = renderSubagentToml({
      name: 'agenticmail-vesper',
      agent: FIXTURE,
      mcpServerName: 'agenticmail',
    });
    const parsed = TOML.parse(text) as { developer_instructions: string };
    expect(parsed.developer_instructions).toContain('Vesper');
    expect(parsed.developer_instructions).toContain('vesper@localhost');
    expect(parsed.developer_instructions).toContain('agt_abc');
  });

  it('mentions Codex (not Claude Code) as the brain', () => {
    const body = renderPersonaBody({
      name: 'agenticmail-vesper',
      agent: FIXTURE,
      mcpServerName: 'agenticmail',
    });
    expect(body).toContain('Codex');
    expect(body).not.toMatch(/Claude Code/);
  });

  it('uses the configurable mcpServerName in tool examples', () => {
    const body = renderPersonaBody({
      name: 'agenticmail-vesper',
      agent: FIXTURE,
      mcpServerName: 'my-custom-name',
    });
    expect(body).toContain('mcp__my-custom-name__list_inbox');
    expect(body).toContain('mcp__my-custom-name__send_email');
    expect(body).toContain('mcp__my-custom-name__reply_email');
    expect(body).not.toMatch(/mcp__agenticmail__/);
  });

  it('warns the agent to pass _account on every MCP call', () => {
    const body = renderPersonaBody({
      name: 'agenticmail-vesper',
      agent: FIXTURE,
      mcpServerName: 'agenticmail',
    });
    expect(body).toMatch(/_account.*Vesper/);
  });

  it('includes owner name when metadata.ownerName is set', () => {
    const body = renderPersonaBody({
      name: 'agenticmail-vesper',
      agent: FIXTURE,
      mcpServerName: 'agenticmail',
    });
    expect(body).toContain('Ope');
  });

  it('handles agents with no role / no owner gracefully', () => {
    const minimal: AgenticMailAccount = {
      id: 'agt_min',
      name: 'Lyra',
      email: 'lyra@localhost',
      apiKey: 'ak_yyyy',
    };
    const text = renderSubagentToml({
      name: 'agenticmail-lyra',
      agent: minimal,
      mcpServerName: 'agenticmail',
    });
    const parsed = TOML.parse(text) as { name: string; developer_instructions: string };
    expect(parsed.name).toBe('agenticmail-lyra');
    expect(parsed.developer_instructions).toContain('Lyra');
  });

  it('host name is parameterizable (parity-ready for shared toolkit)', () => {
    const body = renderPersonaBody(
      { name: 'agenticmail-vesper', agent: FIXTURE, mcpServerName: 'agenticmail' },
      'SomeOtherHost',
    );
    expect(body).toContain('SomeOtherHost');
    expect(body).not.toMatch(/\bCodex\b/);
  });
});
