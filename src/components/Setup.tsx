import { useMemo } from 'react';
import { itemName, producibleItems, RAW_ITEMS, recipes, unit } from '../data/game';
import { allowedRecipes } from '../engine/plan';
import { rawDemand } from '../engine/placement';
import type { Factory } from '../engine/types';
import { useStore } from '../state';
import { CombineSeparateCard } from './CombineSeparateCard';
import { fmt, ItemPicker, ItemTag, NumberInput, confirmDelete } from './ui';

export function Setup({ f }: { f: Factory }) {
  const { state, dispatch, plans } = useStore();
  const plan = plans[f.id];
  const update = (patch: Partial<Factory>) => dispatch({ type: 'update', id: f.id, patch });
  const u = plan.unlocks;

  const options = useMemo(() => {
    const avail = new Set<string>();
    for (const id of allowedRecipes({ ...f, excluded: [] }, u)) for (const [i] of recipes[id].out) avail.add(i);
    return producibleItems.filter((i) => avail.has(i.id));
  }, [u, f]);

  const demand = useMemo(() => rawDemand(f, state.progress, plan), [f, state.progress, plan]);
  const chainItems = useMemo(() => {
    const s = new Set<string>();
    for (const g of plan.groups) for (const [i] of [...g.inputs, ...g.outputs]) s.add(i);
    return s;
  }, [plan]);

  // Recipe choices: for every item in the chain, every unlocked recipe that makes it.
  const recipeChoices = useMemo(() => {
    const avail = allowedRecipes({ ...f, excluded: [] }, u);
    const byItem: Record<string, string[]> = {};
    for (const id of avail) for (const [i] of recipes[id].out) if (chainItems.has(i) || i === f.target) (byItem[i] ??= []).push(id);
    return Object.entries(byItem).filter(([, r]) => r.length > 1).sort((a, b) => itemName(a[0]).localeCompare(itemName(b[0])));
  }, [u, f, chainItems]);

  const rawNeeded = [...new Set([...Object.keys(demand), ...Object.keys(f.extraSupply)])].filter((i) => RAW_ITEMS.includes(i));

  return (
    <div className="setup">
      <section className="card">
        <h2>Product</h2>
        <div className="row gap wrap">
          <ItemPicker value={f.target} options={options} onChange={(target) => update({ target, excluded: [] })} />
          <label className="check">
            <input type="checkbox" checked={f.rate === null} onChange={(e) => update(e.target.checked ? { rate: null, mode: 'max' } : { rate: 10, mode: 'power' })} /> As much as possible
          </label>
          {f.rate !== null && (
            <label>Target <NumberInput value={f.rate} step={0.5} onChange={(v) => update({ rate: v ?? 0 })} /> {unit(f.target)}</label>
          )}
        </div>
        {!options.some((o) => o.id === f.target) && <p className="warn">{itemName(f.target)} can’t be made with your current unlocks.</p>}
        <div className="also">
          <h3>Also make</h3>
          {f.also.length === 0 && <p className="muted small-text">Other products this factory makes at the same time (byproducts you ship, a second product line…).</p>}
          {f.also.map((a, k) => (
            <div key={k} className="row gap wrap also-row">
              <ItemPicker value={a.item} options={options} onChange={(item) => update({ also: f.also.map((x, j) => (j === k ? { ...x, item } : x)) })} />
              <NumberInput value={a.rate} step={0.5} onChange={(v) => update({ also: f.also.map((x, j) => (j === k ? { ...x, rate: v ?? 0 } : x)) })} />
              <span className="muted">{unit(a.item)}</span>
              <button className="small ghost" onClick={() => update({ also: f.also.filter((_, j) => j !== k) })}>Remove</button>
              {a.item === f.target && <span className="warn-text small-text">same as the main product — ignored</span>}
            </div>
          ))}
          <button className="small" onClick={() => {
            const next = options.find((o) => o.id !== f.target && !f.also.some((a) => a.item === o.id));
            if (next) update({ also: [...f.also, { item: next.id, rate: 10 }] });
          }}>+ Add product</button>
        </div>
      </section>

      <section className="card">
        <h2>Overclock settings</h2>
        <div className="row gap wrap">
          <label title="Upper clock limit for production machines">
            Max clock <NumberInput value={f.clockCap} min={1} step={10} width={70} onChange={(v) => update({ clockCap: Math.min(250, v ?? 100) })} /> %
          </label>
          {u.overclock ? (
            <label className="check">
              <input type="checkbox" checked={f.useShards} onChange={(e) => update({ useShards: e.target.checked, clockCap: e.target.checked ? 250 : Math.min(100, f.clockCap) })} />
              Use power shards to overclock ({state.progress.shards} available)
            </label>
          ) : (
            <span className="muted small-text">Overclocking needs the “Overclock Production” MAM research.</span>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Resources</h2>
        <div className="row gap wrap">
          <span>{f.nodes.length} node{f.nodes.length === 1 ? '' : 's'} claimed{f.location ? '' : ' · factory not placed yet'}</span>
          <button className="small" onClick={() => dispatch({ type: 'view', view: 'map' })}>Open map →</button>
          <label className="check">
            <input type="checkbox" checked={f.unlimitedRaw} onChange={(e) => update({ unlimitedRaw: e.target.checked })} /> Unlimited resources (ignore nodes, “what if” plan)
          </label>
        </div>
        {rawNeeded.length > 0 && (
          <table className="table compact">
            <thead><tr><th>Resource</th><th>Needed for target</th><th>From claimed nodes</th><th>Extra supply (train, truck…)</th></tr></thead>
            <tbody>
              {rawNeeded.map((i) => {
                const fromNodes = (plan.supply[i] ?? 0) - (f.extraSupply[i] ?? 0) - f.imports.filter((x) => x.item === i).reduce((a, b) => a + b.rate, 0);
                return (
                  <tr key={i}>
                    <td><ItemTag item={i} /></td>
                    <td>{demand[i] ? `${fmt(demand[i])}/min` : '—'}</td>
                    <td className={fromNodes + 1e-6 < (demand[i] ?? 0) ? 'warn-text' : ''}>{fmt(Math.max(0, fromNodes))}/min</td>
                    <td><NumberInput value={f.extraSupply[i] ?? null} placeholder="0" onChange={(v) => update({ extraSupply: { ...f.extraSupply, [i]: v ?? 0 } })} />/min</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted small-text">Water is pumped on site with Water Extractors unless you claim water wells. “Needed for target” assumes the target rate{f.rate === null ? ' (10/min while maximising)' : ''}.</p>
      </section>

      {recipeChoices.length > 0 && (
        <section className="card">
          <h2>Recipes</h2>
          <p className="muted small-text">The optimiser picks among ticked recipes. Untick any you don’t want to build.</p>
          <div className="recipe-grid">
            {recipeChoices.map(([item, list]) => (
              <div key={item} className="recipe-choice">
                <ItemTag item={item} />
                {list.map((id) => {
                  const r = recipes[id];
                  const on = !f.excluded.includes(id);
                  const used = plan.groups.some((g) => g.recipe.id === id);
                  return (
                    <label key={id} className={`check ${used ? 'used' : ''}`} title={`${r.in.map(([i, a]) => `${a} ${itemName(i)}`).join(' + ')} → ${r.out.map(([i, a]) => `${a} ${itemName(i)}`).join(' + ')}`}>
                      <input type="checkbox" checked={on} onChange={() => update({ excluded: on ? [...f.excluded, id] : f.excluded.filter((x) => x !== id) })} />
                      {r.name}{r.alt && <span className="badge">alt</span>}{used && <span className="badge used">in use</span>}
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      )}

      <CombineSeparateCard f={f} separate={!!f.game} />

      <div className="row gap">
        <button className="primary" onClick={() => dispatch({ type: 'view', view: f.location ? 'results' : 'map' })}>{f.location ? 'See results →' : 'Place on map →'}</button>
        <button className="danger ghost" onClick={() => confirmDelete(f, state.factories) && dispatch({ type: 'remove', id: f.id })}>Delete factory</button>
      </div>
    </div>
  );
}
