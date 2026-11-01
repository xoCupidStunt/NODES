import { useMemo } from 'react';
import { itemName } from '../data/game';
import { logisticsCheck } from '../engine/logistics';
import type { Factory } from '../engine/types';
import { newFactory, useStore } from '../state';
import { useFoundFactories } from './GameFactoriesCard';
import { fmt, ItemTag } from './ui';

const km = (m: number) => (m >= 2000 ? `${fmt(m / 1000, 1)} km` : `${fmt(m, 0)} m`);

/** Warnings for a factory being planned: far supply, and parts it could leave to other factories. */
export function LogisticsCard({ f }: { f: Factory }) {
  const { state, dispatch, plans } = useStore();
  const { found, byFound } = useFoundFactories();
  const plan = plans[f.id];
  const notAdded = useMemo(() => found.filter((ff) => !byFound.has(ff.key)), [found, byFound]);
  const warnings = useMemo(
    () => (plan ? logisticsCheck(f, plan, state.progress, state.factories, plans, notAdded, state.game?.occupied) : []),
    [f, plan, state.progress, state.factories, plans, notAdded, state.game?.occupied],
  );
  if (f.game || !plan || plan.status !== 'ok') return null;

  // New factory for a part, imported here; it opens so it can be placed and set up.
  const makePart = (item: string, rate: number) => {
    const part: Factory = { ...newFactory(state.factories.length + 1), name: `${itemName(item)} factory`, target: item, rate: Math.round(rate * 100) / 100, mode: 'power' };
    if (!confirm(`Create “${part.name}” making ${fmt(rate)}/min ${itemName(item)}, and import it into ${f.name}?\n\nThe new factory opens so you can place it — near ${f.name} or near its resources.`)) return;
    dispatch({ type: 'update', id: f.id, patch: { imports: [...f.imports, { factoryId: part.id, item, rate: part.rate! }] } });
    dispatch({ type: 'add', factory: part });
  };

  return (
    <section className="card logistics">
      <h2>Logistics check</h2>
      {!f.location && <p className="muted small-text">Place the factory on the Map step to check how far its resources and imports travel.</p>}
      {warnings.length === 0 && f.location && <p className="muted">Nothing travels over 1 km, and no big part chains to split off.</p>}
      <div className="tips">
        {warnings.map((w, k) => (
          <div key={k} className={`tip ${w.kind === 'distance' ? 'logistics' : 'import'}`}>
            <div className="tip-kind">{w.kind === 'distance' ? 'distance' : 'split up'}</div>
            <div>
              <b>{w.title}</b>
              <div className="muted">{w.detail}</div>
              {w.options && (
                <div className="tip-options">
                  <div className="tip-options-head">Choose one:</div>
                  <ul>{w.options.map((o, j) => <li key={j}><span className="opt-or">{String.fromCharCode(65 + j)}</span>{o}</li>)}</ul>
                </div>
              )}
              {w.parts && (
                <table className="table compact part-table">
                  <thead><tr><th>Part</th><th className="num">Machines on its own</th><th>Made elsewhere</th><th /></tr></thead>
                  <tbody>
                    {w.parts.map((p) => (
                      <tr key={p.item}>
                        <td><ItemTag item={p.item} rate={p.rate} /></td>
                        <td className="num">{p.machines || '—'}</td>
                        <td className="small-text">
                          {p.makers.length
                            ? p.makers.slice(0, 2).map((m) => `${m.name}${m.distance !== null ? ` (${km(m.distance)})` : ''}`).join(', ')
                            : <span className="warn-text">nowhere yet</span>}
                        </td>
                        <td>
                          {p.makers.length
                            ? <span className="muted small-text">import it on the Map step</span>
                            : <button className="small" onClick={() => makePart(p.item, p.rate)}>Create factory</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
