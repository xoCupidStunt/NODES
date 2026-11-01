import { useState } from 'react';
import { itemName } from '../data/game';
import { separateKind } from '../engine/grouping';
import type { Factory } from '../engine/types';
import { useStore } from '../state';
import { SeparatePanel } from './SeparatePanel';
import { fmt } from './ui';

/** Combine this factory with others, or (when `separate`) separate it into several. */
export function CombineSeparateCard({ f, separate = true }: { f: Factory; separate?: boolean }) {
  const { state, dispatch } = useStore();
  const [picked, setPicked] = useState<string[]>([]);
  const others = state.factories.filter((o) => o.id !== f.id);
  const kind = separateKind(f);
  const chosen = picked.filter((id) => others.some((o) => o.id === id));

  const combine = () => {
    const names = chosen.map((id) => others.find((o) => o.id === id)!.name).join(', ');
    if (!confirm(`Combine ${names} into ${f.name}? Their products are added to this factory and they are removed from the list.`)) return;
    dispatch({ type: 'combineFactories', ids: [f.id, ...chosen] });
    setPicked([]);
  };

  return (
    <section className="card">
      <h2>{separate ? 'Combine or separate' : 'Combine'}</h2>
      <div className={separate ? 'two-col' : ''}>
        <div>
          {separate && <h3>Combine with other factories</h3>}
          {others.length === 0 ? <p className="muted small-text">No other factories yet.</p> : (
            <>
              <div className="combine-list">
                {others.map((o) => (
                  <label key={o.id} className="check">
                    <input type="checkbox" checked={chosen.includes(o.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id)))} />
                    {o.name} <span className="muted small-text">· {itemName(o.target)}{o.game ? ' · in game' : ''}</span>
                  </label>
                ))}
              </div>
              <button className="small" disabled={!chosen.length} onClick={combine}>Combine {chosen.length || ''} into {f.name}</button>
              <p className="muted small-text">Their products become extra products here; nodes, outside supply and imports are pooled. Factories from your game stay linked as one.</p>
            </>
          )}
        </div>
        {separate && <div>
          <h3>Separate</h3>
          {kind === 'game' && f.game && (
            <SeparatePanel
              machineIds={f.game.machineIds}
              applyLabel={(n) => `Separate into ${n} factories`}
              onApply={(gap) => dispatch({ type: 'separateFactory', id: f.id, gap })}
            />
          )}
          {kind === 'products' && (
            <>
              <p className="small-text">Split into one factory per product:</p>
              <ul className="small-text">
                <li>{f.rate === null ? 'max' : fmt(f.rate)} {itemName(f.target)} (keeps the nodes and supply)</li>
                {f.also.map((a) => <li key={a.item}>{fmt(a.rate)} {itemName(a.item)}</li>)}
              </ul>
              <button className="small" onClick={() => dispatch({ type: 'separateFactory', id: f.id, gap: 0 })}>Separate into {f.also.length + 1} factories</button>
            </>
          )}
          {kind === null && <p className="muted small-text">This factory makes one product and isn’t linked to your game, so there’s nothing to separate. Add more products above, or add factories from your game on the Progress page.</p>}
        </div>}
      </div>
    </section>
  );
}
