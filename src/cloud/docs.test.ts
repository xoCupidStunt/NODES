import { describe, expect, it } from 'vitest';
import { emptyState, newFactory, type State } from '../state';
import { applyDocs, changedDocs, docsOf } from './docs';

const withFactories = (...names: string[]): State => ({
  ...emptyState(),
  factories: names.map((n, i) => ({ ...newFactory(i + 1), id: n, name: n, createdAt: i })),
  activeId: names[0] ?? null,
});

describe('cloud docs', () => {
  it('sends only what changed, and deletes removed factories', () => {
    const a = withFactories('a', 'b');
    const prev = docsOf(a);
    expect(changedDocs(prev, docsOf(a))).toEqual([]);

    const b: State = { ...a, factories: [{ ...a.factories[0], name: 'A2' }] };
    const rows = changedDocs(prev, docsOf(b));
    expect(rows.map((r) => r.key).sort()).toEqual(['factory:a', 'factory:b']);
    expect(rows.find((r) => r.key === 'factory:b')!.data).toBeNull();
  });

  it('merges other players’ factories without touching the rest', () => {
    const s = withFactories('a', 'b');
    const c = { ...newFactory(3), id: 'c', name: 'C', createdAt: 5 };
    const next = applyDocs(s, [
      { key: 'factory:b', data: { ...s.factories[1], name: 'B2' } },
      { key: 'factory:c', data: c },
    ]);
    expect(next.factories.map((f) => f.name)).toEqual(['a', 'B2', 'C']);
    expect(next.factories[0]).toBe(s.factories[0]);
    expect(next.progress).toBe(s.progress);
  });

  it('drops a factory someone deleted, its imports, and moves off it', () => {
    const s = withFactories('a', 'b');
    s.factories[1] = { ...s.factories[1], imports: [{ factoryId: 'a', item: 'Desc_IronPlate_C', rate: 10 }] };
    const next = applyDocs({ ...s, view: 'setup' }, [{ key: 'factory:a', data: null }]);
    expect(next.factories.map((f) => f.id)).toEqual(['b']);
    expect(next.factories[0].imports).toEqual([]);
    expect(next.activeId).toBe('b');
  });

  it('replaces shared parts like progress', () => {
    const s = withFactories('a');
    const progress = { ...s.progress, tier: 7 };
    expect(applyDocs(s, [{ key: 'progress', data: progress }]).progress.tier).toBe(7);
  });
});
