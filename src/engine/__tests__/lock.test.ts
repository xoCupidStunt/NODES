import { describe, expect, it } from 'vitest';
import { game } from '../../data/game';
import { milestonesUpTo, type Progress } from '../progression';
import { newFactory, planAll } from '../../state';
import type { Factory } from '../types';
import type { GameSync } from '../saveSync';

const oc = game.schematics.find((s) => s.flags?.includes('BP_UnlockBuildOverclock_C'))!;
const progress: Progress = { tier: 8, milestones: milestonesUpTo(8), mam: [oc.id], alts: [], shards: 60, sloops: 0 };
const make = (id: string): Factory => ({ ...newFactory(1), id, target: 'Desc_IronIngot_C', rate: 900, unlimitedRaw: true, useShards: true, clockCap: 250, priority: 'compact' });
const save = (slotted: number) => ({ shards: { total: 60, slotted }, sloops: { total: 0, slotted: 0 } }) as unknown as GameSync;
const smelters = (p: ReturnType<typeof planAll>, id: string) => p.plans[id].groups.find((g) => g.recipe.name === 'Iron Ingot')!;

describe('lock for building', () => {
  it('keeps a locked plan the same as its shards get slotted, and holds them back from other factories', () => {
    const a = make('a');
    const before = planAll({ factories: [a], progress, game: save(0) });
    expect(smelters(before, 'a').count).toBe(12); // 30 machines' worth at 250 % with 60 spare shards
    const used = before.plans.a.shardsUsed;

    // Lock it, then build it: the save now shows its shards in machines, so there are none spare.
    const locked = { ...a, lock: { at: 0, progress: before.planProgress } };
    const unlockedLater = planAll({ factories: [a], progress, game: save(used) });
    expect(smelters(unlockedLater, 'a').count).toBeGreaterThan(12); // what would happen without the lock
    const lockedLater = planAll({ factories: [locked], progress, game: save(used) });
    expect(smelters(lockedLater, 'a').count).toBe(12);
    expect(smelters(lockedLater, 'a').clock).toBeCloseTo(smelters(before, 'a').clock);

    // A second factory can't plan with the locked one's shards while it still needs them.
    const b = make('b');
    const both = planAll({ factories: [locked, b], progress, game: save(0) });
    expect(both.planProgress.shards).toBe(60 - used);
  });
});
