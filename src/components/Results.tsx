import { useDeferredValue, useMemo } from 'react';
import { itemColor, itemName, MACHINE_COLORS, unit, WATER } from '../data/game';
import { suggestions } from '../engine/suggest';
import type { Factory } from '../engine/types';
import { useStore } from '../state';
import { AsBuiltCard } from './AsBuiltCard';
import { FlowDiagram } from './FlowDiagram';
import { LogisticsCard } from './LogisticsCard';
import { TipCard } from './TipCard';
import { fmt, ItemTag, mw, Stat } from './ui';

const SOURCE: Record<string, string> = {
  nodes: 'claimed nodes', water: 'water extractors', import: 'other factories', manual: 'extra supply', unlimited: 'not assigned yet',
};

export function Results({ f }: { f: Factory }) {
  const { state, dispatch, plans } = useStore();
  const plan = plans[f.id];
  const deferred = useDeferredValue(plan);
  const tips = useMemo(() => suggestions(f, deferred, state.progress, state.factories, plans, state.game?.occupied), [f, deferred, state.progress, state.factories, plans, state.game]);
  const machineCount = plan.groups.reduce((a, g) => a + g.count, 0);
  // Extractors as equipment: grouped by building and resource.
  const extractionRows = useMemo(() => {
    const m = new Map<string, { key: string; name: string; what: string; item: string; count: number; rate: number; power: number; clocks: Set<string> }>();
    for (const e of plan.extraction) {
      const key = e.extractor.id + '|' + e.item;
      const what = e.extractor.kind === 'pressurizer' ? 'powers the resource well' : e.item === WATER ? 'Water' : `${itemName(e.item)} ${e.extractor.kind === 'well' ? 'well' : 'node'}`;
      const cur = m.get(key) ?? { key, name: e.extractor.name, what, item: e.extractor.kind === 'pressurizer' ? '' : e.item, count: 0, rate: 0, power: 0, clocks: new Set<string>() };
      cur.count += e.count;
      cur.rate += e.rate;
      cur.power += e.power;
      if (e.extractor.kind !== 'pressurizer') cur.clocks.add(`${fmt(e.clock, 1)}%`);
      m.set(key, cur);
    }
    return [...m.values()].map((x) => ({ ...x, clock: x.clocks.size === 1 ? [...x.clocks][0] : x.clocks.size ? 'varies' : '—' }));
  }, [plan.extraction]);

  if (plan.status !== 'ok') {
    return (
      <div className="card">
        <h2>Nothing to build yet</h2>
        {plan.warnings.map((w) => <p key={w} className="warn">{w}</p>)}
        <div className="row gap">
          <button onClick={() => dispatch({ type: 'view', view: 'map' })}>Open map</button>
          <button onClick={() => dispatch({ type: 'view', view: 'setup' })}>Back to setup</button>
        </div>
      </div>
    );
  }

  return (
    <div className="results">
      <div className="stats">
        <Stat label="Output" value={`${fmt(plan.rate)} ${unit(f.target)}`} sub={plan.also.length ? `${itemName(f.target)} + ${plan.also.length} more product${plan.also.length > 1 ? 's' : ''}` : itemName(f.target)} />
        <Stat label="Most possible" value={plan.maxRate === null ? 'unlimited' : `${fmt(plan.maxRate)} ${unit(f.target)}`} sub={plan.maxRate === null ? 'no resource cap' : 'with claimed resources'} />
        <Stat label="Power used" value={mw(plan.power.total)} sub={`${mw(plan.power.machines)} machines · ${mw(plan.power.extraction)} extraction`} />
        {plan.power.generated > 0 && <Stat label="Power made" value={mw(plan.power.generated)} sub={`net ${plan.power.net >= 0 ? '+' : ''}${mw(plan.power.net)} to the grid`} />}
        <Stat label="Machines" value={String(machineCount)} sub={`${plan.groups.length} recipes${plan.shardsUsed ? ` · ${plan.shardsUsed} shards` : ''}`} />
        <Stat label="Machine footprint" value={`${fmt(plan.machineArea / 64, 0)} fdn`} sub={`${fmt(plan.machineArea, 0)} m² before spacing`} />
      </div>
      {plan.warnings.map((w) => <p key={w} className="warn">{w}</p>)}

      <LogisticsCard f={f} />

      <AsBuiltCard f={f} plan={plan} />

      <section className="card">
        <div className="row between">
          <h2>Equipment</h2>
          <button className="primary" onClick={() => dispatch({ type: 'view', view: 'schematic' })}>Generate build schematic →</button>
        </div>
        <table className="table">
          <thead>
            <tr><th>Machine</th><th>Recipe</th><th>Count</th><th>Clock (all same)</th><th>Or</th><th>Shards</th><th>Power</th><th>In / min</th><th>Out / min</th></tr>
          </thead>
          <tbody>
            {plan.groups.map((g) => (
              <tr key={g.id}>
                <td><span className="mdot" style={{ background: MACHINE_COLORS[g.machine.id] ?? '#888' }} />{g.machine.name}</td>
                <td>{g.recipe.name}{g.recipe.alt && <span className="badge">alt</span>}</td>
                <td className="num"><b>{g.count}</b> <span className="muted">({fmt(g.exact, 3)})</span></td>
                <td className="num">{fmt(g.clock, 4)}%</td>
                <td className="muted small-text">{g.lastClock > 0 && g.count > 1 ? `${g.full} × ${fmt(g.maxClock)}% + 1 × ${fmt(g.lastClock, 4)}%` : '—'}</td>
                <td className="num">{g.shardsPerMachine ? `${g.shardsPerMachine} each` : '—'}</td>
                <td className="num">{mw(g.power)}</td>
                <td>{g.inputs.map(([i, v]) => <div key={i}><ItemTag item={i} rate={v} /></div>)}</td>
                <td>{g.outputs.map(([i, v]) => <div key={i}><ItemTag item={i} rate={v} /></div>)}</td>
              </tr>
            ))}
            {extractionRows.length > 0 && <tr className="equip-sep"><td colSpan={9}>Extraction</td></tr>}
            {extractionRows.map((x) => (
              <tr key={x.key}>
                <td><span className="mdot" style={{ background: x.item ? itemColor(x.item) : '#888' }} />{x.name}</td>
                <td className="muted">{x.what}</td>
                <td className="num"><b>{x.count}</b></td>
                <td className="num">{x.clock}</td>
                <td className="muted small-text">—</td>
                <td className="num">—</td>
                <td className="num">{mw(x.power)}</td>
                <td className="muted">—</td>
                <td>{x.item ? <ItemTag item={x.item} rate={x.rate} /> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="two-col">
        <section className="card">
          <h2>Inputs</h2>
          <table className="table compact">
            <tbody>
              {plan.inputs.map((x, k) => (
                <tr key={k}><td><ItemTag item={x.item} rate={x.rate} /></td><td className={x.source === 'unlimited' ? 'warn-text' : 'muted'}>{SOURCE[x.source]}</td></tr>
              ))}
            </tbody>
          </table>
          {plan.also.length > 0 && (
            <>
              <h3>Also makes</h3>
              {plan.also.map(([i, v]) => <div key={i}><ItemTag item={i} rate={v} /></div>)}
            </>
          )}
          {plan.surplus.length > 0 && (
            <>
              <h3>Byproducts / leftovers</h3>
              {plan.surplus.map(([i, v]) => <div key={i}><ItemTag item={i} rate={v} /></div>)}
            </>
          )}
        </section>
        <section className="card">
          <h2>Extraction</h2>
          {plan.extraction.length === 0 && <p className="muted">No extractors — inputs come from other factories or extra supply.</p>}
          <table className="table compact">
            <thead><tr><th>Building</th><th>Where</th><th>Clock</th><th>Gives</th><th>Power</th></tr></thead>
            <tbody>
              {plan.extraction.map((e, k) => (
                <tr key={k}>
                  <td>{e.count > 1 ? `${e.count} × ` : ''}{e.extractor.name}</td>
                  <td className="muted">{e.node ? `${e.node.purity} ${itemName(e.item)}${e.node.type === 'well' ? ' well' : ''}` : 'any water'}</td>
                  <td className="num">{e.extractor.kind === 'pressurizer' ? '—' : `${fmt(e.clock, 2)}%`}</td>
                  <td>{e.rate > 0 ? <ItemTag item={e.item} rate={e.rate} /> : <span className="muted">powers well</span>}</td>
                  <td className="num">{mw(e.power)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="card">
        <h2>Layout diagram</h2>
        <p className="muted small-text">Production chain from raw inputs (left) to the product (right). Line labels show item, rate and the belt/pipe tier needed.</p>
        <FlowDiagram plan={plan} target={f.target} />
      </section>

      <section className="card">
        <h2>Suggestions</h2>
        {deferred !== plan && <p className="muted">Updating…</p>}
        {tips.length === 0 && <p className="muted">Nothing to improve with what you have unlocked.</p>}
        <div className="tips">
          {tips.map((t, k) => <TipCard key={k} t={t} />)}
        </div>
      </section>
    </div>
  );
}
