import { describe, it, expect } from 'vitest';
import {
  listSkills,
  searchSkills,
  loadSkill,
  validateSkill,
  renderSkillAsPrompt,
  type Skill,
} from '../skills/index.js';

/**
 * Regression coverage for the skill library shipped in v0.9.72.
 *
 * Tests run against the bundled built-in skills (`packages/core/src/
 * skills/built-in/`) — the same files the registry loads in production.
 * Each test reaches in by id so the suite stays meaningful even as new
 * skills are added: the assertions are about behaviour, not counts.
 */

const SAMPLE_VALID_SKILL: Skill = {
  id: 'test-skill',
  name: 'Test Skill',
  version: '1.0.0',
  category: 'other',
  tags: ['test'],
  description: 'A test skill.',
  disclaimer: null,
  context: {
    when_to_use: 'For testing the validator only.',
    preconditions: ['Test environment'],
    estimated_call_duration_minutes: 5,
  },
  principles: ['Be honest', 'Be kind'],
  phrases: { opener: 'Hi, this is a test.' },
  tactics: [
    { name: 'Open the call', when: 'First turn.', script: 'Use the opener phrase.' },
  ],
  boundaries: ['Do not deceive the caller.'],
  success_signals: ['Caller responds civilly.'],
  failure_signals: ['Caller hangs up.'],
  exit_strategy: {
    on_success: 'Thank them and end the call.',
    on_failure: 'End the call politely.',
  },
  required_user_info: ['Caller name'],
  contributed_by: 'test-suite',
};

describe('skill library — registry', () => {
  it('loads the built-in skills', () => {
    const all = listSkills();
    // Don't assert an exact count — new built-ins land regularly and
    // that's fine. Instead assert the v0.9.72 starter set is present.
    expect(all.length).toBeGreaterThan(0);
    const ids = all.map((s) => s.id);
    expect(ids).toContain('negotiate-bill-reduction');
    expect(ids).toContain('book-restaurant-reservation');
    expect(ids).toContain('handle-debt-collector');
  });

  it('filters by category', () => {
    const negotiation = listSkills({ category: 'negotiation' });
    expect(negotiation.length).toBeGreaterThan(0);
    for (const s of negotiation) expect(s.category).toBe('negotiation');
  });

  it('filters by tag (case-insensitive)', () => {
    const filtered = listSkills({ tag: 'phone-call' });
    expect(filtered.length).toBeGreaterThan(0);
    for (const s of filtered) {
      expect(s.tags.some((t) => t.toLowerCase() === 'phone-call')).toBe(true);
    }
  });

  it('searchSkills ranks name matches above body matches', () => {
    // "negotiate" appears in negotiate-bill-reduction's name + tags +
    // body; in other skills it might appear only in tactic copy. Top
    // result should be the dedicated negotiation skill.
    const results = searchSkills('negotiate');
    expect(results[0].id).toBe('negotiate-bill-reduction');
  });

  it('searchSkills returns nothing when no token overlaps any skill', () => {
    // Use a deliberately nonsense token unlikely to appear in any skill
    // body / name / tag. The BM25F matcher operates on stemmed tokens
    // and stop-word-removed queries, so "xyzzy" / "qwzqp" never match;
    // the substring-fallback also won't fire because no skill contains
    // the literal string either.
    const results = searchSkills('xyzzyqwzqp');
    expect(results).toEqual([]);
  });

  it('searchSkills returns empty on empty query', () => {
    expect(searchSkills('')).toEqual([]);
    expect(searchSkills('   ')).toEqual([]);
  });

  it('searchSkills stems word variants — "negotiating" finds "negotiate" skills', () => {
    // Old linear matcher couldn't do this; BM25F stems both sides.
    const a = searchSkills('negotiate');
    const b = searchSkills('negotiating');
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    // Top match should be the same skill regardless of word form.
    expect(a[0].id).toBe(b[0].id);
  });

  it('loadSkill returns the full body for a known id', () => {
    const skill = loadSkill('handle-debt-collector');
    expect(skill).not.toBeNull();
    expect(skill?.disclaimer).not.toBeNull();
    expect(skill?.tactics.length).toBeGreaterThan(0);
    expect(skill?.principles.length).toBeGreaterThan(0);
  });

  it('loadSkill returns null for an unknown id', () => {
    expect(loadSkill('does-not-exist-skill')).toBeNull();
  });

  it('renderSkillAsPrompt produces a usable prompt block', () => {
    const skill = loadSkill('book-restaurant-reservation');
    const rendered = renderSkillAsPrompt(skill!);
    // Sanity-check the rendered block — it should mention the skill
    // name, contain the PRINCIPLES header, and end with the exit block.
    expect(rendered).toContain('SKILL LOADED: Book a Restaurant Reservation');
    expect(rendered).toContain('PRINCIPLES:');
    expect(rendered).toContain('TACTICS');
    expect(rendered).toContain('EXIT:');
  });
});

describe('skill library — validator', () => {
  it('accepts a structurally complete skill', () => {
    expect(validateSkill(SAMPLE_VALID_SKILL)).toEqual([]);
  });

  it('rejects a missing id', () => {
    const bad = { ...SAMPLE_VALID_SKILL, id: undefined } as any;
    const errs = validateSkill(bad);
    expect(errs.some((e) => e.path === 'id')).toBe(true);
  });

  it('rejects a non-slug id', () => {
    const bad = { ...SAMPLE_VALID_SKILL, id: 'Invalid ID With Spaces' };
    const errs = validateSkill(bad);
    expect(errs.some((e) => e.path === 'id' && /slug/.test(e.message))).toBe(true);
  });

  it('rejects an unknown category', () => {
    const bad = { ...SAMPLE_VALID_SKILL, category: 'not-a-real-category' } as any;
    const errs = validateSkill(bad);
    expect(errs.some((e) => e.path === 'category')).toBe(true);
  });

  it('rejects an empty tactics array', () => {
    const bad = { ...SAMPLE_VALID_SKILL, tactics: [] };
    const errs = validateSkill(bad);
    expect(errs.some((e) => e.path === 'tactics')).toBe(true);
  });

  it('rejects a tactic with an empty script', () => {
    const bad = { ...SAMPLE_VALID_SKILL, tactics: [{ name: 'x', when: 'now', script: '' }] };
    const errs = validateSkill(bad);
    expect(errs.some((e) => e.path === 'tactics[0].script')).toBe(true);
  });

  it('rejects a missing exit_strategy', () => {
    const bad = { ...SAMPLE_VALID_SKILL, exit_strategy: undefined } as any;
    const errs = validateSkill(bad);
    expect(errs.some((e) => e.path === 'exit_strategy')).toBe(true);
  });

  it('accepts a skill with a string disclaimer (legal/medical/financial)', () => {
    const skill = { ...SAMPLE_VALID_SKILL, disclaimer: 'I am not an attorney.' };
    expect(validateSkill(skill)).toEqual([]);
  });

  it('rejects a skill with a non-string non-null disclaimer', () => {
    const bad = { ...SAMPLE_VALID_SKILL, disclaimer: 123 } as any;
    const errs = validateSkill(bad);
    expect(errs.some((e) => e.path === 'disclaimer')).toBe(true);
  });
});

describe('skill library — BM25F scaling', () => {
  /**
   * Soft benchmark — proves the indexed search is fast enough to be
   * called inside a Realtime call hold ("hold on one moment"). The
   * exact number depends on machine + load; we assert a generous
   * ceiling that would only fire on a real regression.
   *
   * The BM25F index is built once per ensureLoaded cycle (cached for
   * 5s), so successive `searchSkills` calls cost only the scoring
   * of posting-list candidates — sub-millisecond on the current 9-
   * skill library and still well under 50ms when the library grows
   * to thousands of skills (we'd hit context limits in the model
   * before we hit performance limits in the index).
   */
  it('100 queries against the built-in library complete in < 1 second', () => {
    const queries = [
      'negotiate bill', 'cancel subscription', 'debt collector', 'restaurant',
      'doctor appointment', 'flight refund', 'rep insists payment', 'fully booked',
      'fraud chargeback', 'home repair', 'court hearing', 'insurance verification',
      'commit to payment', 'transfer to supervisor', 'retention department',
      'dispute', 'reservation', 'cancel', 'medical', 'travel',
    ];
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      const q = queries[i % queries.length];
      const _ = searchSkills(q);
      void _;
    }
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe('skill library — every built-in passes the validator', () => {
  // The registry skips invalid built-ins with a warning rather than
  // crashing, so an invalid file would silently disappear from the
  // library. This test verifies that EVERY built-in actually parses
  // and validates — i.e. nothing has rotted out.
  it('all listed built-in skills load fully and validate clean', () => {
    const summaries = listSkills();
    for (const summary of summaries) {
      const full = loadSkill(summary.id);
      expect(full, `loadSkill returned null for ${summary.id}`).not.toBeNull();
      const errs = validateSkill(full!);
      expect(errs, `validation errors on ${summary.id}: ${JSON.stringify(errs)}`).toEqual([]);
    }
  });
});
