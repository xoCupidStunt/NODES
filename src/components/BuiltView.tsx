import { useDeferredValue, useMemo } from 'react';
import { extractors, isPower, itemColor, itemName, MACHINE_COLORS, machines, perMinute, POWER, RAW_ITEMS, recipes, WATER } from '../data/game';
import { buildPlan, clockPower, nodeById, nodeRate } from '../engine/plan';
import { recipePower } from '../engine/solver';
import { surplusItems } from '../engine/gameFactories';
import { SURPLUS_HELP } from './GameFactoriesCard';
import { suggestions, type Tip } from '../engine/suggest';
import type { BuiltGroup, Factory } from '../engine/types';
import { useStore } from '../state';
import { AsBuiltCard } from './AsBuiltCard';
import { CombineSeparateCard } from './CombineSeparateCard';
import { ago } from './SaveSyncCard';
import { fmt, ItemTag, mw, rateText, Stat } from './ui';

/** Totals for one recipe's machines at the clocks set in game. */
function groupRates(g: BuiltGroup) {
  const r = recipes[g.recipe];
  const m = machines[r?.machine];
  const speed = g.clocks.reduce((a, [c, n]) => a + (c / 100) * n, 0); // machine-equivalents at 100 %
  const power = g.clocks.reduce((a, [c, n]) => a + clockPower(recipePower(r), m?.exp ?? 1.321929, c) * n, 0);
  return {
    r, m, speed, power,
    avgClock: g.count ? (speed / g.count) * 100 : 0,
    inputs: r.in.map(([i, a]) => [i, perMinute(r, a) * speed] as [string, number]),
    outputs: r.out.map(([i, a]) => [i, perMinute(r, a) * speed] as [string, number]),
  };
}

/** A factory that is already built in the game: what it makes, how well, and how to get more out of it. */
export function BuiltView({ f }: { f: Factory }) {
  const { state, dispatch, plans } = useStore();
  const g = f.game!;
  const best = plans[f.id];
  // Most this factory could make from the nodes and outside supply it already has.
  // The other products it makes in game stay at their current rates, so "more" never means "drop something else".
  const fMax = useMemo<Factory>(() => {
    const extra = surplusItems(f.game!);
    const also = [...(f.also ?? [])];
    for (const [item, rate] of f.game!.outputs) {
      if (item !== f.target && !extra.has(item) && !also.some((a) => a.item === item)) also.push({ item, rate });
    }
    return { ...f, mode: 'max', rate: null, also };
  }, [f]);
  const maxPlan = useMemo(() => buildPlan(fMax, state.progress), [fMax, state.progress]);
  const deferredMax = useDeferredValue(maxPlan);

  const rows = useMemo(() => g.groups.map((x) => ({ g: x, ...groupRates(x) })), [g]);
  const builtOut = g.outputs.find(([i]) => i === f.target)?.[1] ?? 0;
  const powerMade = g.outputs.find(([i]) => i === POWER)?.[1] ?? 0;
  const extra = useMemo(() => surplusItems(g), [g]);
  const products = g.outputs.filter(([i]) => !extra.has(i) || i === f.target);
  const surplus = g.outputs.filter(([i]) => extra.has(i) && i !== f.target);
  const machinesBuilt = g.groups.reduce((a, x) => a + x.count, 0);
  const avgClock = machinesBuilt ? rows.reduce((a, x) => a + x.speed, 0) / machinesBuilt * 100 : 0;
  const slow = rows.filter((x) => x.avgClock < 99.5);
  const slowCount = slow.reduce((a, x) => a + x.g.count, 0);

  // Extractors on the factory's belts and pipes (from the save), and what they deliver at their clocks.
  const exs = g.extractors ?? [];
  const exCount = exs.reduce((a, x) => a + x.count, 0);
  const exPower = exs.reduce((a, x) => a + x.power, 0);
  const own: Record<string, number> = {};
  const ownCount: Record<string, number> = {};
  for (const x of exs) if (x.item) { own[x.item] = (own[x.item] ?? 0) + x.rate; ownCount[x.item] = (ownCount[x.item] ?? 0) + x.count; }
  const waterNeed = g.inputs.find(([i]) => i === WATER)?.[1] ?? 0;
  const waterHave = own[WATER] ?? 0;

  // Raw resources: what its extractors (or, before a resync, its nodes) give vs. what the machines use.
  const nodeSupply: Record<string, number> = {};
  if (exs.length) Object.assign(nodeSupply, own);
  else for (const id of f.nodes) {
    const n = nodeById[id];
    if (n) nodeSupply[n.item] = (nodeSupply[n.item] ?? 0) + nodeRate(n, best.unlocks);
  }
  delete nodeSupply[WATER];
  // Water is tracked on its own, so it doesn't count here.
  const rawUse = g.inputs.filter(([i]) => RAW_ITEMS.includes(i) && i !== WATER);
  const rawSupplied = Object.values(nodeSupply).reduce((a, b) => a + b, 0) + rawUse.reduce((a, [i]) => a + (f.extraSupply[i] ?? 0), 0);
  const rawUsed = rawUse.reduce((a, [, v]) => a + v, 0);

  const possible = deferredMax.status === 'ok' ? deferredMax.rate : null;
  const outputPct = possible && possible > 0 ? Math.min(100, (builtOut / possible) * 100) : null;
  const bestOk = best.status === 'ok' && best.rate > 0;
  const powerPerItem = builtOut > 0 ? g.power / builtOut : 0;
  const bestPowerPerItem = bestOk ? best.power.machines / best.rate : 0;
  const bestMachines = bestOk ? best.groups.reduce((a, x) => a + x.count, 0) : 0;

  const tips = useMemo<Tip[]>(() => {
    const t: Tip[] = [];
    if (possible !== null && possible > builtOut * 1.02) {
      t.push({
        kind: 'resource', score: 95,
        title: `Up to ${rateText(f.target, possible)} of ${itemName(f.target)} with what it already gets (+${fmt(((possible - builtOut) / Math.max(builtOut, 1e-9)) * 100, 0)}%)`,
        detail: `The planner's best layout for the same nodes and outside supply makes ${rateText(f.target, possible)} instead of ${rateText(f.target, builtOut)}. Open “Plan changes” → Results for the machines and clocks.`,
      });
    }
    if (slowCount > 0) {
      const gain = slow.map((x) => {
        const main = x.outputs[0];
        return main ? `${fmt(main[1] / (x.avgClock / 100) - main[1])} ${itemName(main[0])}` : '';
      }).filter(Boolean).slice(0, 3).join(', ');
      t.push({
        kind: 'clock', score: 60,
        title: `${slowCount} machine${slowCount > 1 ? 's run' : ' runs'} below 100%`,
        detail: `${slow.map((x) => `${x.g.count} × ${x.r.name} at ${fmt(x.avgClock, 1)}%`).slice(0, 4).join(', ')}. At 100% they would make about ${gain} more per minute — if their inputs keep up.`,
      });
    }
    // Water: what the machines need vs. what its water extractors pump.
    if (waterNeed > 0.01 && exs.length) {
      const pump = extractors.Build_WaterPump_C;
      if (waterHave + 0.01 < waterNeed && best.unlocks.buildings.has(pump.id)) {
        const short = waterNeed - waterHave;
        const n = Math.ceil(short / pump.rate - 1e-9);
        const have = ownCount[WATER]
          ? `its ${ownCount[WATER]} water extractor${ownCount[WATER] > 1 ? 's pump' : ' pumps'} ${rateText(WATER, waterHave)}`
          : 'no water extractors are connected';
        t.push({
          kind: 'resource', score: 90,
          title: `Water is short by ${rateText(WATER, short)}`,
          detail: `The machines need ${rateText(WATER, waterNeed)} but ${have}. Add ${n} Water Extractor${n > 1 ? 's' : ''}${n * pump.rate > short + 1e-6 ? ` (clocked to ${fmt((short / n / pump.rate) * 100, 1)}%)` : ''}.`,
        });
      } else if (waterHave - waterNeed >= pump.rate - 0.01) {
        const spare = Math.floor((waterHave - waterNeed) / pump.rate + 1e-9);
        t.push({
          kind: 'clock', score: 25,
          title: `${spare} water extractor${spare > 1 ? 's are' : ' is'} more than needed`,
          detail: `They pump ${rateText(WATER, waterHave)} for a need of ${rateText(WATER, waterNeed)}. Removing ${spare > 1 ? 'them' : 'it'} or underclocking saves about ${mw(spare * pump.power)}. Keep them if you plan to grow the factory.`,
        });
      }
    }
    if (bestOk) {
      const builtRecipes = new Set(g.groups.map((x) => x.recipe));
      const missing = best.groups.filter((x) => !builtRecipes.has(x.recipe.id) && x.recipe.alt);
      if (missing.length) {
        t.push({
          kind: 'recipe', score: 50,
          title: `You have ${missing.length === 1 ? 'an alternate recipe' : `${missing.length} alternate recipes`} this factory doesn’t use`,
          detail: `${missing.map((x) => x.recipe.name).join(', ')} — the best plan for the same output uses ${bestMachines} machines and ${mw(best.power.machines)} instead of ${machinesBuilt} and ${mw(g.power)}.`,
        });
      }
    }
    // Surplus: say how much is over-made and how to use it or make less.
    for (const [item, left] of surplus) {
      const makers = rows.filter((x) => x.outputs.some(([i]) => i === item));
      const made = makers.reduce((a, x) => a + (x.outputs.find(([i]) => i === item)?.[1] ?? 0), 0);
      const used = made - left;
      const pct = made > 0 ? (used / made) * 100 : 0;
      // Only a generator the player has unlocked.
      const gen = Object.values(recipes).find((r) => r.generator && !r.noPlan && r.in[0]?.[0] === item && best.unlocks.buildings.has(r.machine));
      let idea = '';
      if (gen) {
        const per = gen.in[0][1];
        const mwEach = gen.out.find(([i]) => i === POWER)?.[1] ?? 0;
        const n = Math.ceil(left / per - 1e-9);
        idea = ` Or burn it: ${n} more ${machines[gen.machine]?.name ?? 'generator'}${n > 1 ? 's' : ''}${n * per > left + 1e-6 ? ` at ${fmt((left / per / n) * 100, 1)}%` : ''} would turn it into about ${mw((left / per) * mwEach)}.`;
      }
      t.push({
        kind: 'byproduct', score: 55,
        title: `${rateText(item, left)} ${itemName(item)} is surplus`,
        detail: `The ${makers.map((x) => `${x.g.count} × ${x.r.name}`).join(' and ')} can make ${rateText(item, made)}, but this factory only uses ${rateText(item, used)}. Unless the extra leaves by another route, it backs up and those machines idle part of the time. Underclock them to about ${fmt(pct * (makers[0]?.avgClock ?? 100) / 100, 1)}% to match.${idea}`,
      });
    }
    const fromSuggest = deferredMax.status === 'ok'
      ? suggestions(fMax, deferredMax, state.progress, state.factories, plans, state.game?.occupied, true).filter((x) => x.kind !== 'clock' || x.title.includes('shard'))
      : [];
    return [...t, ...fromSuggest].sort((a, b) => b.score - a.score);
  }, [surplus, rows, possible, builtOut, slow, slowCount, bestOk, best, g, f.target, fMax, deferredMax, state.progress, state.factories, plans, state.game, bestMachines, machinesBuilt]);

  const rename = () => {
    const name = prompt('Factory name', f.name);
    if (name && name.trim()) dispatch({ type: 'update', id: f.id, patch: { name: name.trim() } });
  };

  return (
    <div className="built">
      <header className="top built-top">
        <div className="built-title">
          <h1>{f.name}</h1>
          <button className="small ghost" onClick={rename} title="Rename">✎ Rename</button>
          <span className="ingame-tag">built in game</span>
          <span className="muted small-text">updated {ago(g.updatedAt)}</span>
        </div>
        <div className="row gap wrap">
          <button className="primary" onClick={() => dispatch({ type: 'view', view: 'schematic' })}>Generate schematic</button>
          <button onClick={() => dispatch({ type: 'showOnMap', focus: { kind: 'factory', id: f.id } })}>Show on map</button>
          <button className="ghost" onClick={() => dispatch({ type: 'view', view: 'setup' })}>Plan changes…</button>
        </div>
      </header>

      <div className="content">
        {g.missing && <p className="warn">These machines weren’t in the last synced save — the factory may have been torn down or rebuilt.</p>}

        <div className="stats">
          <Stat label="Main product" value={rateText(f.target, builtOut)} sub={itemName(f.target)} />
          <Stat label="Products" value={String(products.length)} sub={surplus.length ? `+ ${surplus.length} surplus` : 'made here'} />
          <Stat label="Machines" value={String(machinesBuilt)} sub={`${g.groups.length} recipes${exCount ? ` + ${exCount} extractors` : ''}`} />
          <Stat label="Power used" value={mw(g.power + exPower)} sub={exCount ? `${mw(g.power)} machines · ${mw(exPower)} extractors` : 'production machines'} />
          {powerMade > 0 && <Stat label="Power made" value={mw(powerMade)} sub={`net ${powerMade - g.power >= 0 ? '+' : ''}${mw(powerMade - g.power)} to the grid`} />}
          <Stat label="Average clock" value={`${fmt(avgClock, 1)}%`} sub={slowCount ? `${slowCount} below 100%` : 'all at 100% or more'} />
        </div>

        <div className="two-col">
          <section className="card">
            <h2>Products</h2>
            <table className="table compact">
              <tbody>
                {products.map(([i, v]) => (
                  <tr key={i} className={i === f.target ? 'main-row' : ''}>
                    <td><ItemTag item={i} rate={v} /></td>
                    <td className="muted small-text">{i === f.target ? 'main product' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {surplus.length > 0 && (
              <>
                <h3 className="surplus-head">Surplus <span className="surplus-tag">not a product</span></h3>
                <table className="table compact">
                  <tbody>
                    {surplus.map(([i, v]) => (
                      <tr key={i} className="make-surplus" title={SURPLUS_HELP}>
                        <td><ItemTag item={i} rate={v} /></td>
                        <td className="muted small-text">made more than used here</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted small-text">{SURPLUS_HELP}</p>
              </>
            )}
          </section>
          <section className="card">
            <h2>Uses</h2>
            <table className="table compact">
              <tbody>
                {g.inputs.map(([i, v]) => (
                  <tr key={i}>
                    <td><ItemTag item={i} rate={v} /></td>
                    <td className="muted small-text">
                      <SourceText item={i} need={v} own={own[i]} ownCount={ownCount[i]} nodes={f.nodes.filter((id) => nodeById[id]?.item === i).length} outside={f.extraSupply[i]} hasExtractors={exs.length > 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <section className="card">
          <h2>Equipment</h2>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Machine</th><th>Recipe</th><th className="num">Count</th><th>Clocks</th><th>In / min</th><th>Out / min</th><th className="num">Power</th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.g.recipe}>
                    <td><span className="mdot" style={{ background: MACHINE_COLORS[x.r.machine] ?? '#888' }} />{x.m?.name}</td>
                    <td>{x.r.name}{x.r.alt && <span className="badge">alt</span>}</td>
                    <td className="num"><b>{x.g.count}</b></td>
                    <td className="small-text">
                      {x.g.clocks.map(([c, n]) => `${n} × ${fmt(c, 1)}%`).join(', ')}
                      {x.g.boosted > 0 && <div className="muted">{x.g.boosted} with somersloops</div>}
                    </td>
                    <td>{x.inputs.map(([i, v]) => <div key={i}><ItemTag item={i} rate={v} /></div>)}</td>
                    <td>{x.outputs.map(([i, v]) => <div key={i}><ItemTag item={i} rate={v} /></div>)}</td>
                    <td className="num">{mw(x.power)}</td>
                  </tr>
                ))}
                {exs.length > 0 && <tr className="equip-sep"><td colSpan={7}>Extraction</td></tr>}
                {exs.map((x) => (
                  <tr key={x.type + x.item}>
                    <td><span className="mdot" style={{ background: x.item ? itemColor(x.item) : '#888' }} />{extractors[x.type]?.name ?? x.type}</td>
                    <td className="muted">{x.item ? (x.item === WATER ? 'Water' : `${itemName(x.item)} node`) : 'powers the resource well'}</td>
                    <td className="num"><b>{x.count}</b></td>
                    <td className="small-text">{x.clocks.map(([c, n]) => `${n} × ${fmt(c, 1)}%`).join(', ')}</td>
                    <td className="muted">—</td>
                    <td>{x.item ? <ItemTag item={x.item} rate={x.rate} /> : <span className="muted">—</span>}</td>
                    <td className="num">{mw(x.power)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h2>Efficiency</h2>
          <div className="eff">
            <Meter
              label="Output vs. what’s possible"
              pct={outputPct}
              value={possible === null ? 'no plan' : `${rateText(f.target, builtOut)} of ${rateText(f.target, possible)}`}
              note="Main product now, vs. the most the planner can make from the same nodes and outside supply."
            />
            {!isPower(f.target) && <Meter
              label="Power per item"
              pct={bestOk && powerPerItem > 0 ? Math.min(100, (bestPowerPerItem / powerPerItem) * 100) : null}
              value={bestOk ? `${fmt(powerPerItem, 2)} MW vs. best ${fmt(bestPowerPerItem, 2)} MW` : '—'}
              note="Machine power per item/min of the main product, vs. the best layout for the same output."
            />}
            <Meter
              label="Machines"
              pct={bestOk && machinesBuilt ? Math.min(100, (bestMachines / machinesBuilt) * 100) : null}
              value={bestOk ? `${machinesBuilt} built vs. ${bestMachines} in the best layout` : '—'}
              note="Fewer machines for the same output means less to build and a smaller footprint."
            />
            <Meter
              label="Clock use"
              pct={Math.min(100, avgClock)}
              value={`${fmt(avgClock, 1)}% average`}
              note="How hard the machines are working. Below 100% leaves output on the table."
            />
            {rawSupplied > 0 && (
              <Meter
                label="Resource use"
                pct={Math.min(100, (rawUsed / rawSupplied) * 100)}
                value={`${fmt(rawUsed)} of ${fmt(rawSupplied)} /min raw resources`}
                note="Raw resources the machines use, vs. what its nodes (with your best miners) and outside supply provide."
              />
            )}
          </div>
        </section>

        <section className="card">
          <h2>Suggested changes</h2>
          <p className="muted small-text">Only changes you can make now, with the buildings, recipes, power shards and somersloops you already have.</p>
          {deferredMax !== maxPlan && <p className="muted">Updating…</p>}
          {tips.length === 0 && <p className="muted">Nothing obvious to improve with what you have unlocked.</p>}
          <div className="tips">
            {tips.map((t, k) => (
              <div key={k} className={`tip ${t.kind}`}>
                <div className="tip-kind">{t.kind}</div>
                <div><b>{t.title}</b><div className="muted">{t.detail}</div></div>
              </div>
            ))}
          </div>
        </section>

        {bestOk && (
          <details className="card compare">
            <summary><h2>Recipe by recipe vs. the best layout</h2></summary>
            <AsBuiltCard f={f} plan={best} />
          </details>
        )}

        <CombineSeparateCard f={f} />
      </div>
    </div>
  );
}

function Meter({ label, pct, value, note }: { label: string; pct: number | null; value: string; note: string }) {
  const tone = pct === null ? '' : pct >= 90 ? 'good' : pct >= 70 ? 'ok' : 'low';
  return (
    <div className="meter">
      <div className="row between"><b>{label}</b><span className={`meter-pct ${tone}`}>{pct === null ? '—' : `${fmt(pct, 0)}%`}</span></div>
      <div className="meter-bar"><div className={tone} style={{ width: `${pct ?? 0}%` }} /></div>
      <div className="small-text muted">{value} · {note}</div>
    </div>
  );
}

/** Where an input comes from: its own extractors (with a shortfall warning), nodes, outside supply. */
function SourceText({ item, need, own, ownCount, nodes, outside, hasExtractors }: {
  item: string; need: number; own?: number; ownCount?: number; nodes: number; outside?: number; hasExtractors: boolean;
}) {
  const parts: React.ReactNode[] = [];
  if (own) {
    const short = need - (outside ?? 0) - own;
    parts.push(
      <span key="own" className={short > 0.01 ? 'warn-text' : ''}>
        {ownCount} {item === WATER ? 'water extractor' : 'extractor'}{(ownCount ?? 0) > 1 ? 's' : ''} give {rateText(item, own)}
        {short > 0.01 ? ` — short ${rateText(item, short)}` : ''}
      </span>,
    );
  } else if (nodes) parts.push(<span key="nodes">{nodes} node{nodes > 1 ? 's' : ''}</span>);
  if (outside) parts.push(<span key="out">{parts.length ? ' + ' : ''}from outside</span>);
  if (!parts.length) {
    if (item === WATER) parts.push(<span key="w" className={hasExtractors ? 'warn-text' : ''}>{hasExtractors ? 'no water extractors connected' : 'water extractors'}</span>);
    else parts.push(<span key="x">{RAW_ITEMS.includes(item) ? 'extractors' : 'made nearby'}</span>);
  }
  return <>{parts}</>;
}
