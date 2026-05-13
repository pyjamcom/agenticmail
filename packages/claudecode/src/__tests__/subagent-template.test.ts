import { describe, it, expect } from 'vitest';
import { renderSubagentMarkdown, MANAGED_BY_MARKER } from '../subagent-template.js';
import type { AgenticMailAccount } from '../types.js';

const FOLA: AgenticMailAccount = {
  id: '06b312c0-dde7-4729-a83e-d3bdc6c87e3b',
  name: 'Fola',
  email: 'fola@localhost',
  apiKey: 'ak_test',
  role: 'secretary',
  metadata: { ownerName: 'Ope' },
};

describe('renderSubagentMarkdown', () => {
  it('opens with YAML frontmatter', () => {
    const md = renderSubagentMarkdown({ name: 'agenticmail-fola', agent: FOLA, mcpServerName: 'agenticmail' });
    expect(md.startsWith('---\n')).toBe(true);
    const close = md.indexOf('\n---\n', 4);
    expect(close).toBeGreaterThan(0);
  });

  it('embeds the managed-by marker in frontmatter', () => {
    const md = renderSubagentMarkdown({ name: 'agenticmail-fola', agent: FOLA, mcpServerName: 'agenticmail' });
    expect(md).toContain(MANAGED_BY_MARKER);
  });

  it('restricts tools in frontmatter to a curated essentials list + meta-tools', () => {
    // Tiered loading: pre-load only the most-common tools to keep the
    // subagent's spawn-time context cheap. Everything else is reachable
    // via the request_tools/invoke meta-tools. The whitelist must include
    // BOTH the day-to-day mail/agent tools AND the two meta-tools — without
    // request_tools/invoke the agent has no way to reach the rest of the
    // catalogue, which would silently break uncommon ops.
    const md = renderSubagentMarkdown({ name: 'agenticmail-fola', agent: FOLA, mcpServerName: 'agenticmail' });
    // The frontmatter is delimited by lines containing only "---". Pull
    // out everything between the first and second "---" line.
    const lines = md.split('\n');
    const dashIdx: number[] = [];
    for (let i = 0; i < lines.length && dashIdx.length < 2; i++) {
      if (lines[i] === '---') dashIdx.push(i);
    }
    expect(dashIdx.length).toBe(2);
    const frontmatter = lines.slice(dashIdx[0] + 1, dashIdx[1]).join('\n');
    const toolsLine = frontmatter.split('\n').find(l => l.startsWith('tools:')) ?? '';
    expect(toolsLine).toMatch(/mcp__agenticmail__list_inbox/);
    expect(toolsLine).toMatch(/mcp__agenticmail__send_email/);
    expect(toolsLine).toMatch(/mcp__agenticmail__reply_email/);
    expect(toolsLine).toMatch(/mcp__agenticmail__whoami/);
    expect(toolsLine).toMatch(/mcp__agenticmail__request_tools/);
    expect(toolsLine).toMatch(/mcp__agenticmail__invoke/);
    // call_agent must be pre-loaded — it is the synchronous RPC primitive
    // for agent-to-agent coordination, which is the headline platform
    // feature. Putting it behind request_tools would make multi-agent
    // patterns expensive in the very case they're meant to be cheap.
    expect(toolsLine).toMatch(/mcp__agenticmail__call_agent/);
    // Sanity: list is intentionally short (≤ ~15 tools).
    const toolCount = (toolsLine.match(/mcp__agenticmail__/g) ?? []).length;
    expect(toolCount).toBeLessThanOrEqual(15);
    expect(toolCount).toBeGreaterThanOrEqual(8);
  });

  it('mentions request_tools and invoke in the body so the subagent knows how to reach unloaded tools', () => {
    const md = renderSubagentMarkdown({ name: 'agenticmail-fola', agent: FOLA, mcpServerName: 'agenticmail' });
    expect(md).toMatch(/request_tools/);
    expect(md).toMatch(/invoke/);
    // The body should explicitly describe the discover-then-invoke pattern.
    expect(md).toMatch(/catalogue|catalog/i);
  });

  it('uses the supplied MCP server name when building example tool calls AND the frontmatter whitelist', () => {
    const md = renderSubagentMarkdown({ name: 'agenticmail-fola', agent: FOLA, mcpServerName: 'pony' });
    expect(md).toContain('mcp__pony__list_inbox');
    expect(md).toContain('mcp__pony__request_tools');
    expect(md).toContain('mcp__pony__invoke');
    expect(md).not.toContain('mcp__agenticmail__list_inbox');
  });

  it('instructs the subagent to pass _account on every call', () => {
    const md = renderSubagentMarkdown({ name: 'agenticmail-fola', agent: FOLA, mcpServerName: 'agenticmail' });
    expect(md).toMatch(/_account: "Fola"/);
    expect(md).toMatch(/MUST pass.*_account/i);
  });

  it('embodies the persona (does not pretend to be a relay)', () => {
    const md = renderSubagentMarkdown({ name: 'agenticmail-fola', agent: FOLA, mcpServerName: 'agenticmail' });
    expect(md).toMatch(/You are \*\*Fola\*\*/);
    // Old relay-style language should be gone.
    expect(md).not.toMatch(/return that text verbatim/);
    expect(md).not.toMatch(/thin bridge/);
  });

  it('forbids generic Claude Code tools (Bash/Read/Edit/etc.)', () => {
    const md = renderSubagentMarkdown({ name: 'agenticmail-fola', agent: FOLA, mcpServerName: 'agenticmail' });
    expect(md).toMatch(/Do NOT use generic Claude Code tools/);
  });

  it('quotes description safely (no stray quotes)', () => {
    const trickyAgent = { ...FOLA, name: 'rude"agent', email: 'rude"agent@localhost' };
    const md = renderSubagentMarkdown({ name: 'agenticmail-rude', agent: trickyAgent, mcpServerName: 'agenticmail' });
    const fm = md.split('\n---')[0];
    // description must contain the escaped quote
    expect(fm).toMatch(/description: ".*\\".*"/);
  });

  it('declares the agent identity prominently in the body', () => {
    const md = renderSubagentMarkdown({ name: 'agenticmail-fola', agent: FOLA, mcpServerName: 'agenticmail' });
    expect(md).toContain('# You are Fola');
    expect(md).toContain('fola@localhost');
  });

  it('embeds the AgenticMail agent id in frontmatter as a comment', () => {
    const md = renderSubagentMarkdown({ name: 'agenticmail-fola', agent: FOLA, mcpServerName: 'agenticmail' });
    expect(md).toContain(FOLA.id);
  });
});
