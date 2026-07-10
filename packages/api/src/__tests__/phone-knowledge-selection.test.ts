import { describe, expect, it } from 'vitest';
import { selectVoiceKnowledgeEntries } from '../routes/phone.js';

describe('voice knowledge selection', () => {
  it('keeps the highest-ranked fact and removes title duplicates across source layers', () => {
    const selected = selectVoiceKnowledgeEntries([
      { id: 'primary', title: 'Невский Брокер: Морские перевозки' },
      { id: 'duplicate', title: 'Морские перевозки' },
      { id: 'customs', title: 'Таможенное оформление' },
    ], 5);

    expect(selected.map((entry) => entry.id)).toEqual(['primary', 'customs']);
  });

  it('preserves relevance order and respects the voice result limit', () => {
    const selected = selectVoiceKnowledgeEntries([
      { id: 'one', title: 'Первый факт' },
      { id: 'two', title: 'Второй факт' },
      { id: 'three', title: 'Третий факт' },
    ], 2);

    expect(selected.map((entry) => entry.id)).toEqual(['one', 'two']);
  });
});
