import { useMemo, useState } from 'react';
import { itemName as shortName, recipes } from '../data/game';
import { altSchematics, computeUnlocks, mamResearch, mamTrees, milestones, milestonesUpTo } from '../engine/progression';
import { useStore } from '../state';
import { GameFactoriesCard } from './GameFactoriesCard';
import { SaveSyncCard } from './SaveSyncCard';
import { NumberInput } from './ui';

const TIER_NAMES = ['Onboarding', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5', 'Tier 6', 'Tier 7', 'Tier 8', 'Tier 9'];

export function ProgressPanel() {
  const { state, dispatch } = useStore();
  const p = state.progress;
  const set = (patch: Partial<typeof p>) => dispatch({ type: 'progress', patch });
  const toggle = (key: 'milestones' | 'mam' | 'alts', id: string) =>
    set({ [key]: p[key].includes(id) ? p[key].filter((x) => x !== id) : [...p[key], id] });
  const u = useMemo(() => computeUnlocks(p), [p]);
  const [altQ, setAltQ] = useState('');
  const [tab, setTab] = useState<'milestones' | 'mam' | 'alts'>('milestones');

  const alts = useMemo(() => {
    const q = altQ.trim().toLowerCase();
    return altSchematics
      .map((s) => ({ s, r: s.recipes.map((id) => recipes[id]).filter(Boolean) }))
      .filter(({ s, r }) => !q || s.name.toLowerCase().includes(q) || r.some((x) => x.name.toLowerCase().includes(q)))
      .sort((a, b) => a.s.name.localeCompare(b.s.name));
  }, [altQ]);

  return (
    <div className="content">
      <h1>Progress</h1>
      <p className="muted">The planner only uses machines, belts and recipes you have unlocked. Currently: {u.recipes.size} production recipes, {[...u.buildings].length} buildables{u.overclock ? ', overclocking' : ''}{u.amplify ? ', somersloop amplification' : ''}.</p>

      <SaveSyncCard />
      <GameFactoriesCard />

      <section className="card">
        <h2>Current tier</h2>
        <div className="tier-row">
          {TIER_NAMES.map((n, t) => (
            <button key={t} className={`tier ${p.tier === t ? 'on' : ''} ${p.tier > t ? 'done' : ''}`} onClick={() => set({ tier: t, milestones: milestonesUpTo(t) })}>{n}</button>
          ))}
        </div>
        <p className="muted small-text">Picking a tier ticks every milestone up to it. Untick milestones you skipped below.</p>
        <div className="row gap">
          <label>Power shards <NumberInput value={p.shards} onChange={(v) => set({ shards: v ?? 0 })} /></label>
          <label>Somersloops <NumberInput value={p.sloops} onChange={(v) => set({ sloops: v ?? 0 })} /></label>
        </div>
      </section>

      <div className="tabs sub">
        <button className={tab === 'milestones' ? 'on' : ''} onClick={() => setTab('milestones')}>Milestones ({p.milestones.length}/{milestones.length})</button>
        <button className={tab === 'mam' ? 'on' : ''} onClick={() => setTab('mam')}>MAM research ({p.mam.length})</button>
        <button className={tab === 'alts' ? 'on' : ''} onClick={() => setTab('alts')}>Hard-drive alternates ({p.alts.length})</button>
      </div>

      {tab === 'milestones' && (
        <div className="grid-cards">
          {Array.from({ length: 9 }, (_, i) => i + 1).map((t) => (
            <section key={t} className="card">
              <h3>Tier {t}</h3>
              {milestones.filter((m) => m.tier === t).map((m) => (
                <label key={m.id} className="check">
                  <input type="checkbox" checked={p.milestones.includes(m.id)} onChange={() => toggle('milestones', m.id)} />
                  {m.name}
                </label>
              ))}
            </section>
          ))}
        </div>
      )}

      {tab === 'mam' && (
        <div className="grid-cards">
          {mamTrees.map((tree) => {
            const list = mamResearch.filter((s) => s.tree === tree);
            const all = list.every((s) => p.mam.includes(s.id));
            return (
              <section key={tree} className="card">
                <div className="row between">
                  <h3>{tree}</h3>
                  <button className="small ghost" onClick={() => set({ mam: all ? p.mam.filter((id) => !list.some((s) => s.id === id)) : [...new Set([...p.mam, ...list.map((s) => s.id)])] })}>{all ? 'None' : 'All'}</button>
                </div>
                {list.map((s) => (
                  <label key={s.id} className="check" title={s.recipes.map((r) => recipes[r]?.name).filter(Boolean).join(', ')}>
                    <input type="checkbox" checked={p.mam.includes(s.id)} onChange={() => toggle('mam', s.id)} />
                    {s.name}
                    {s.recipes.length > 0 && <span className="badge">{s.recipes.length} recipe{s.recipes.length > 1 ? 's' : ''}</span>}
                  </label>
                ))}
              </section>
            );
          })}
        </div>
      )}

      {tab === 'alts' && (
        <section className="card">
          <div className="row between">
            <input placeholder="Search alternates or what they make…" value={altQ} onChange={(e) => setAltQ(e.target.value)} style={{ width: 320 }} />
            <span className="muted">{p.alts.length} of {altSchematics.length} unlocked</span>
          </div>
          <div className="alt-list">
            {alts.map(({ s, r }) => (
              <label key={s.id} className="check alt">
                <input type="checkbox" checked={p.alts.includes(s.id)} onChange={() => toggle('alts', s.id)} />
                <span>
                  <b>{s.name}</b>
                  <span className="muted small-text"> — {r.map((x) => `${x.in.map(([i, a]) => `${a} ${shortName(i)}`).join(' + ')} → ${x.out.map(([i, a]) => `${a} ${shortName(i)}`).join(' + ')}`).join('; ')}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
