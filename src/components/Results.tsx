import { Fragment, useDeferredValue, useMemo, useState } from 'react';
import { itemColor, itemName, MACHINE_COLORS, unit, WATER } from '../data/game';
import { shardsFor } from '../engine/plan';
import { dist } from '../engine/placement';
import { bearing } from '../engine/schematic';
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
    const m = new Map<string, { key: string; name: string; what: string; item: string; count: number; rate: number; power: number; clocks: Set<string>; sites: typeof plan.extraction }>();
    for (const e of plan.extraction) {
      const key = e.extractor.id + '|' + e.item;
      const what = e.extractor.kind === 'pressurizer' ? 'powers the resource well' : e.item === WATER ? 'Water' : `${itemName(e.item)} ${e.extractor.kind === 'well' ? 'well' : 'node'}`;
      const cur = m.get(key) ?? { key, name: e.extractor.name, what, item: e.extractor.kind === 'pressurizer' ? '' : e.item, count: 0, rate: 0, power: 0, clocks: new Set<string>(), sites: [] };
      cur.sites.push(e);
      cur.count += e.count;
      cur.rate += e.rate;
      cur.power += e.power;
      if (e.extractor.kind !== 'pressurizer') cur.clocks.add(`${fmt(e.clock, 1)}%`);
      m.set(key, cur);
    }
    return [...m.values()].map((x) => ({ ...x, clock: x.clocks.size === 1 ? [...x.clocks][0] : x.clocks.size ? 'varies' : '—' }));
  }, [plan.extraction]);

  // Extractor groups opened to show each one (closed by default).
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen((o) => { const n = new Set(o); if (n.has(key)) n.delete(key); else n.add(key); return n; });

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
        <Stat label={plan.also.length ? 'Main product' : 'Output'} value={`${fmt(plan.rate)} ${unit(f.target)}`} sub={plan.also.length ? `${itemName(f.target)} + ${plan.also.length} more — see Products` : itemName(f.target)} />
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
            <tr><th>Machine</th><th>Recipe</th><th>Count</th><th>Clock</th><th>Shards</th><th>Power</th><th>In / min</th><th>Out / min</th></tr>
          </thead>
          <tbody>
            {plan.groups.map((g) => (
              <tr key={g.id}>
                <td><span className="mdot" style={{ background: MACHINE_COLORS[g.machine.id] ?? '#888' }} />{g.machine.name}</td>
                <td>{g.recipe.name}{g.recipe.alt && <span className="badge">alt</span>}</td>
                <td className="num"><b>{g.count}</b> <span className="muted">({fmt(g.exact, 3)})</span></td>
                <td className="num">{fmt(g.clock, 4)}%</td>
                <td className="num">{g.shardsPerMachine ? `${g.shardsPerMachine} each` : '—'}</td>
                <td className="num">{mw(g.power)}</td>
                <td>{g.inputs.map(([i, v]) => <div key={i}><ItemTag item={i} rate={v} /></div>)}</td>
                <td>{g.outputs.map(([i, v]) => <div key={i}><ItemTag item={i} rate={v} /></div>)}</td>
              </tr>
            ))}
            {extractionRows.length > 0 && <tr className="equip-sep"><td colSpan={8}>Extraction</td></tr>}
            {extractionRows.map((x) => {
              const isOpen = open.has(x.key);
              const shards = x.sites.reduce((a, e) => a + shardsFor(e.clock) * e.count, 0);
              return (
                <Fragment key={x.key}>
                  <tr className="ex-group" onClick={() => toggle(x.key)} title={isOpen ? 'Hide each extractor' : 'Show each extractor'}>
                    <td><button className="ex-toggle" aria-expanded={isOpen} aria-label={isOpen ? 'Collapse' : 'Expand'}>{isOpen ? '▾' : '▸'}</button><span className="mdot" style={{ background: x.item ? itemColor(x.item) : '#888' }} />{x.name}</td>
                    <td className="muted">{x.what}</td>
                    <td className="num"><b>{x.count}</b></td>
                    <td className="num">{x.clock}</td>
                    <td className="num">{shards ? `${shards} total` : '—'}</td>
                    <td className="num">{mw(x.power)}</td>
                    <td className="muted">—</td>
                    <td>{x.item ? <ItemTag item={x.item} rate={x.rate} /> : <span className="muted">—</span>}</td>
                  </tr>
                  {isOpen && x.sites.map((e, k) => (
                    <tr key={x.key + k} className="ex-site">
                      <td className="muted small-text">{e.count > 1 ? `${e.count} × ` : ''}{e.extractor.name}</td>
                      <td className="small-text">
                        {e.node ? `${e.extractor.kind === 'pressurizer' ? 'well centre' : `${e.node.purity} ${itemName(e.item)}${e.node.type === 'well' ? ' satellite' : ' node'}`}` : 'any water, on site'}
                        {e.node && f.location && <span className="muted"> · {fmt(dist(e.node, f.location), 0)} m {bearing(f.location, e.node)}</span>}
                      </td>
                      <td className="num small-text">{e.count}</td>
                      <td className="num small-text">{e.extractor.kind === 'pressurizer' ? '—' : `${fmt(e.clock, 2)}%`}</td>
                      <td className="num small-text">{shardsFor(e.clock) ? `${shardsFor(e.clock)} each` : '—'}</td>
                      <td className="num small-text">{mw(e.power)}</td>
                      <td className="muted">—</td>
                      <td>{e.rate > 0 ? <ItemTag item={e.item} rate={e.rate} /> : <span className="muted small-text">powers the well</span>}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="two-col">
        <section className="card">
          <h2>Products</h2>
          <table className="table compact">
            <tbody>
              <tr className="main-row"><td><ItemTag item={f.target} rate={plan.rate} /></td><td className="muted small-text">main product</td></tr>
              {plan.also.map(([i, v]) => {
                const a = f.also.find((x) => x.item === i);
                const how = a?.how === 'share' ? `shared, ${fmt(a.ratio ?? 1)} per 1 ${itemName(f.target)}` : a?.how === 'leftover' ? 'from leftovers' : 'fixed rate';
                return <tr key={i}><td><ItemTag item={i} rate={v} /></td><td className="muted small-text">{how}</td></tr>;
              })}
            </tbody>
          </table>
          {plan.surplus.length > 0 && (
            <>
              <h3>Byproducts / leftovers</h3>
              <p className="muted small-text">Made but not used or wanted — ship, sink or store them.</p>
              {plan.surplus.map(([i, v]) => <div key={i}><ItemTag item={i} rate={v} /></div>)}
            </>
          )}
        </section>
        <section className="card">
          <h2>Inputs</h2>
          <table className="table compact">
            <tbody>
              {plan.inputs.map((x, k) => (
                <tr key={k}><td><ItemTag item={x.item} rate={x.rate} /></td><td className={x.source === 'unlimited' ? 'warn-text' : 'muted'}>{SOURCE[x.source]}</td></tr>
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
