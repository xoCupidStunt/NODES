import { machines, MACHINE_COLORS, recipes } from '../data/game';
import type { Plan } from '../engine/plan';
import type { Factory } from '../engine/types';
import { fmt, ItemTag, mw } from './ui';
import { ago } from './SaveSyncCard';

/** Side-by-side: what's built in the game vs. the planner's plan for the same output. */
export function AsBuiltCard({ f, plan }: { f: Factory; plan: Plan }) {
  const g = f.game;
  if (!g) return null;
  const builtMachines = g.groups.reduce((a, x) => a + x.count, 0);
  const planMachines = plan.groups.reduce((a, x) => a + x.count, 0);
  const builtOut = g.outputs.find(([i]) => i === f.target)?.[1] ?? 0;

  const rows = new Map<string, { recipe: string; built?: (typeof g.groups)[number]; planned?: Plan['groups'][number] }>();
  for (const b of g.groups) rows.set(b.recipe, { recipe: b.recipe, built: b });
  for (const p of plan.groups) rows.set(p.recipe.id, { ...(rows.get(p.recipe.id) ?? { recipe: p.recipe.id }), planned: p });
  const list = [...rows.values()].sort((a, b) => (b.built?.count ?? 0) + (b.planned?.count ?? 0) - (a.built?.count ?? 0) - (a.planned?.count ?? 0));

  const dMachines = planMachines - builtMachines;
  const dPower = plan.power.machines - g.power;

  return (
    <section className="card as-built">
      <div className="row between wrap">
        <h2>Built in game vs. this plan</h2>
        <span className="muted small-text">From your save · updated {ago(g.updatedAt)}</span>
      </div>
      {g.missing && <p className="warn">These machines weren’t in the last synced save — the factory may have been torn down or rebuilt.</p>}
      <div className="stats compare">
        <div className="stat"><div className="stat-label">Output in game</div><div className="stat-value">{fmt(builtOut)}<span className="muted small-text"> /min</span></div><div className="stat-sub">plan: {fmt(plan.rate)} /min</div></div>
        <div className="stat"><div className="stat-label">Machines</div><div className="stat-value">{builtMachines}</div><div className={`stat-sub ${dMachines < 0 ? 'ok-text' : ''}`}>plan: {planMachines} ({dMachines > 0 ? '+' : ''}{dMachines})</div></div>
        <div className="stat"><div className="stat-label">Machine power</div><div className="stat-value">{mw(g.power)}</div><div className={`stat-sub ${dPower < -0.5 ? 'ok-text' : ''}`}>plan: {mw(plan.power.machines)} ({dPower > 0 ? '+' : ''}{mw(dPower)})</div></div>
      </div>
      <table className="table compact">
        <thead><tr><th>Recipe</th><th className="num">Built</th><th>Clocks in game</th><th className="num">Plan</th><th>Plan clock</th></tr></thead>
        <tbody>
          {list.map(({ recipe, built, planned }) => {
            const r = recipes[recipe];
            const m = machines[r?.machine];
            const same = built && planned && built.count === planned.count;
            return (
              <tr key={recipe} className={!built ? 'plan-only' : !planned ? 'built-only' : ''}>
                <td><span className="mdot" style={{ background: MACHINE_COLORS[r?.machine] ?? '#888' }} />{r?.name ?? recipe}{r?.alt && <span className="badge">alt</span>} <span className="muted small-text">{m?.name}</span></td>
                <td className="num">{built ? <b>{built.count}</b> : '—'}</td>
                <td className="small-text muted">{built ? built.clocks.map(([c, n]) => `${n}×${fmt(c, 1)}%`).join(', ') + (built.boosted ? ` · ${built.boosted} with somersloops` : '') : 'not built'}</td>
                <td className={`num ${same ? '' : 'diff'}`}>{planned ? <b>{planned.count}</b> : '—'}</td>
                <td className="small-text muted">{planned ? `${fmt(planned.clock, 2)}%` : 'not in plan'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row gap wrap small-text">
        <span className="muted">In game it also gives:</span>
        {g.outputs.filter(([i]) => i !== f.target).map(([i, v]) => <ItemTag key={i} item={i} rate={v} />)}
        {g.outputs.length <= 1 && <span className="muted">nothing else</span>}
      </div>
      <p className="muted small-text">The plan is the planner’s best layout for the same output with your unlocks and build goal. Recipes only in the plan are highlighted — they’re worth a look. Change the goal or recipes on Setup to compare other options.</p>
    </section>
  );
}
