/**
 * Tests for normalizeWakeList — the function that converts the raw
 * `wake` field shipped from MCP / HTTP into the canonical
 * lowercased bare-name array the dispatcher uses for gating.
 *
 * Regression coverage for the wake-allowlist-is-a-JSON-string bug
 * that quietly excluded every recipient on 0.9.0-0.9.12: Claude
 * sometimes passes `wake: '["orion"]'` (JSON-stringified) instead
 * of `wake: ["orion"]`, and the old CSV-only string path treated
 * the whole blob as a single agent name → dispatcher logged
 * `list=["[\"orion\"]"]` and excluded the real "orion" wake.
 */
import { describe, it, expect } from 'vitest';
import { normalizeWakeList } from '../routes/mail.js';

describe('normalizeWakeList', () => {
  it('returns undefined for undefined / null', () => {
    expect(normalizeWakeList(undefined)).toBeUndefined();
    expect(normalizeWakeList(null)).toBeUndefined();
  });

  it('treats "all" and the WAKE_ALL_SENTINEL as opt-out (undefined → no filter)', () => {
    expect(normalizeWakeList('all')).toBeUndefined();
    expect(normalizeWakeList('__wake_all__')).toBeUndefined();
  });

  it('passes a real array through (lowercased, @localhost stripped)', () => {
    expect(normalizeWakeList(['Orion', 'Vesper@localhost'])).toEqual(['orion', 'vesper']);
  });

  it('splits comma-separated strings into bare names', () => {
    expect(normalizeWakeList('orion, vesper, atlas')).toEqual(['orion', 'vesper', 'atlas']);
    expect(normalizeWakeList('orion@localhost,vesper@localhost')).toEqual(['orion', 'vesper']);
  });

  it('parses JSON-stringified arrays — regression for 0.9.13', () => {
    // Claude sometimes serializes the array before calling the MCP tool
    // (model confusion or middleware mishandling). The old behaviour
    // dropped the whole call into the CSV path, producing a one-element
    // list whose single string was `'["orion"]'`. Fix: detect the JSON
    // shape and parse it back into an array.
    expect(normalizeWakeList('["orion"]')).toEqual(['orion']);
    expect(normalizeWakeList('["orion","vesper"]')).toEqual(['orion', 'vesper']);
    // Same with whitespace + @localhost suffixes mixed in.
    expect(normalizeWakeList('  ["Orion@localhost", "Vesper"]  ')).toEqual(['orion', 'vesper']);
    // Empty JSON array means "wake nobody" (canonical "send silently").
    expect(normalizeWakeList('[]')).toEqual([]);
  });

  it('falls back to CSV when the brackets are present but the JSON is bogus', () => {
    // Looks like a JSON array but isn't valid — we don't want a stray
    // `[orion]` to silently fail and produce undefined. Treat as CSV.
    expect(normalizeWakeList('[orion]')).toEqual(['[orion]']);
  });

  it('returns undefined for non-string non-array inputs', () => {
    expect(normalizeWakeList(42)).toBeUndefined();
    expect(normalizeWakeList(true)).toBeUndefined();
    expect(normalizeWakeList({ name: 'orion' })).toBeUndefined();
  });
});
