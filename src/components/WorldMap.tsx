import { useEffect, useMemo, useState } from 'react';
import { itemColor, nodes } from '../data/game';
import type { FoundFactory } from '../engine/gameFactories';
import { nodeById } from '../engine/plan';
import type { Factory } from '../engine/types';
import { useStore } from '../state';
import { foundName, Makes, useFoundFactories } from './GameFactoriesCard';
import { MapImageCard } from './mapImage';
import { FULL_VIEW, MapBackdrop, PURITY_R, usePanZoom } from './mapKit';
import { amountName, fmt, ItemTag, mw } from './ui';

type Sel = { kind: 'found' | 'factory'; id: string } | null;

/** Every factory on one map: the ones in the planner and the ones found in the save. */
export function WorldMap() {
  const { state, dispatch, plans } = useStore();
  const { found, byFound, add, small } = useFoundFactories();
  const map = usePanZoom(FULL_VIEW);
  const [sel, setSel] = useState<Sel>(state.mapFocus);
  const [showNodes, setShowNodes] = useState(true);
  const [showMined, setShowMined] = useState(true);
  const [showFound, setShowFound] = useState(true);
  const [showSmall, setShowSmall] = useState(false);
  const [hoverName, setHoverName] = useState<string | null>(null);

  const inGame = useMemo(() => new Set(state.game?.occupied ?? []), [state.game]);
  const notAdded = found.filter((ff) => !byFound.has(ff.key) && (showSmall || !small(ff)));
  const placed = state.factories.filter((f) => f.location);

  const where = (s: Sel) => {
    if (!s) return null;
    if (s.kind === 'found') {
      const ff = found.find((x) => x.key === s.id);
      return ff ? { at: ff.location, b: ff.built.bounds } : null;
    }
    const f = state.factories.find((x) => x.id === s.id);
    return f?.location ? { at: f.location, b: f.game?.bounds } : null;
  };
  const zoomTo = (s: Sel) => {
    const w = where(s);
    if (!w) return;
    const span = w.b ? Math.max(w.b.maxX - w.b.minX, w.b.maxY - w.b.minY) * 2.5 : 0;
    map.focus(w.at, Math.max(60000, span));
  };
  const pick = (s: Sel, zoom = false) => {
    setSel(s);
    if (zoom) zoomTo(s);
  };

  // "Show on map" from elsewhere: select and zoom once the map has its size.
  useEffect(() => {
    if (!state.mapFocus) return;
    setSel(state.mapFocus);
    const id = window.setTimeout(() => zoomTo(state.mapFocus), 30);
    return () => window.clearTimeout(id);
  }, [state.mapFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  const px = map.pxToWorld;
  const zoomedIn = map.vb.w < 250000;
  const selFound = sel?.kind === 'found' ? found.find((x) => x.key === sel.id) ?? null : null;
  const selFactory = sel?.kind === 'factory' ? state.factories.find((x) => x.id === sel.id) ?? null : null;

  const click = (s: Sel) => (e: React.PointerEvent) => {
    if (!map.wasClick()) return;
    e.stopPropagation();
    pick(s);
  };

  return (
    <div className="content">
      <h1>World map</h1>
      <p className="muted">All your factories: the ones you’re planning here{state.game ? ' and the ones built in your game' : ''}. Click one for details.</p>
      <div className="map-layout world">
        <div className="map-side">
          {selFound && <FoundDetails ff={selFound} linked={byFound.get(selFound.key) ?? null} onAdd={() => add([selFound])} onOpen={(id) => dispatch({ type: 'select', id, view: 'built' })} />}
          {selFactory && <FactoryDetails f={selFactory} rate={plans[selFactory.id]?.status === 'ok' ? plans[selFactory.id].rate : null} />}

          <section className="card">
            <h3>Your factories ({state.factories.length})</h3>
            {state.factories.length === 0 && <p className="muted small-text">None yet.</p>}
            <div className="world-list">
              {state.factories.map((f) => (
                <button key={f.id} className={`world-item ${sel?.kind === 'factory' && sel.id === f.id ? 'on' : ''}`} disabled={!f.location} onClick={() => pick({ kind: 'factory', id: f.id }, true)}>
                  <span className="wmark planner" />
                  <span>{f.name}{f.game && <span className="ingame-tag">in game</span>}{!f.location && <span className="muted small-text"> · not placed</span>}</span>
                </button>
              ))}
            </div>
          </section>

          {state.game && (
            <section className="card">
              <h3>In your game, not added ({notAdded.length})</h3>
              <div className="world-list">
                {notAdded.map((ff) => (
                  <button key={ff.key} className={`world-item ${sel?.kind === 'found' && sel.id === ff.key ? 'on' : ''}`} onClick={() => pick({ kind: 'found', id: ff.key }, true)}>
                    <span className="wmark found" />
                    <span>{foundName(ff, state.foundNames)} <span className="muted small-text">· {ff.machines} machines</span></span>
                  </button>
                ))}
                {notAdded.length === 0 && <p className="muted small-text">All added.</p>}
              </div>
              {notAdded.length > 0 && <button className="small" onClick={() => add(notAdded)}>Add all {notAdded.length}</button>}
            </section>
          )}

          <section className="card">
            <h3>Show</h3>
            <label className="check"><input type="checkbox" checked={showNodes} onChange={(e) => setShowNodes(e.target.checked)} /> Resource nodes</label>
            {state.game && <label className="check"><input type="checkbox" checked={showMined} onChange={(e) => setShowMined(e.target.checked)} /> Nodes mined in your game</label>}
            {state.game && <label className="check"><input type="checkbox" checked={showFound} onChange={(e) => setShowFound(e.target.checked)} /> Game factories not added yet</label>}
            {state.game && <label className="check"><input type="checkbox" checked={showSmall} onChange={(e) => setShowSmall(e.target.checked)} /> Include small setups (1–2 machines)</label>}
            <div className="legend small-text">
              <div><span className="wmark planner" /> factory in the planner</div>
              <div><span className="wmark linked" /> linked to your game</div>
              {state.game && <div><span className="wmark found" /> built in game, not added</div>}
              {state.game && <div><span className="ring ingame" /> node mined in game</div>}
            </div>
          </section>

          <MapImageCard />
        </div>

        <div className="map-wrap">
          <svg ref={map.svgRef} className="map" viewBox={map.viewBox} {...map.handlers} onPointerUp={(e) => { if (map.wasClick() && e.target === e.currentTarget) setSel(null); map.handlers.onPointerUp(); }}>
            <MapBackdrop pxToWorld={px} />

            {showNodes && nodes.map((n) => {
              const mined = inGame.has(n.id);
              if (!showMined && mined) return null;
              const r = Math.max(700, 4 * px) * PURITY_R[n.purity];
              return (
                <g key={n.id} opacity={mined ? 0.9 : 0.45} pointerEvents="none">
                  {mined && showMined && <rect x={n.x - r - 4 * px} y={n.y - r - 4 * px} width={2 * r + 8 * px} height={2 * r + 8 * px} fill="none" stroke="#38bdf8" strokeWidth={1.2 * px} />}
                  <circle cx={n.x} cy={n.y} r={r} fill={itemColor(n.item)} />
                </g>
              );
            })}

            {/* Lines from planner factories to their nodes and imports */}
            {placed.map((f) => {
              const on = sel?.kind === 'factory' && sel.id === f.id;
              return (
                <g key={'l' + f.id} opacity={on ? 0.95 : 0.3} pointerEvents="none">
                  {f.nodes.map((id) => {
                    const n = nodeById[id];
                    return n ? <line key={id} x1={f.location!.x} y1={f.location!.y} x2={n.x} y2={n.y} stroke={itemColor(n.item)} strokeWidth={(on ? 2 : 1.2) * px} strokeDasharray={`${5 * px} ${3 * px}`} /> : null;
                  })}
                  {f.imports.map((imp, k) => {
                    const src = state.factories.find((x) => x.id === imp.factoryId);
                    return src?.location ? <line key={k} x1={src.location.x} y1={src.location.y} x2={f.location!.x} y2={f.location!.y} stroke={itemColor(imp.item)} strokeWidth={3 * px} /> : null;
                  })}
                </g>
              );
            })}

            {/* Game factories not added yet */}
            {showFound && notAdded.map((ff) => {
              const on = sel?.kind === 'found' && sel.id === ff.key;
              const s = (on ? 10 : 7) * px;
              const b = ff.built.bounds;
              const name = foundName(ff, state.foundNames);
              const label = on || (zoomedIn && (ff.machines >= 5 || map.vb.w < 100000)) || ff.machines >= 25;
              return (
                <g key={ff.key} className="fmark" onPointerUp={click({ kind: 'found', id: ff.key })} onPointerEnter={() => setHoverName(`${name} · ${ff.machines} machines · in game, not added`)} onPointerLeave={() => setHoverName(null)}>
                  {b && <rect x={b.minX - 1500} y={b.minY - 1500} width={b.maxX - b.minX + 3000} height={b.maxY - b.minY + 3000} pointerEvents="none" className={`footprint found ${on ? 'on' : ''}`} strokeWidth={1.2 * px} strokeDasharray={`${4 * px} ${3 * px}`} />}
                  <rect x={ff.location.x - s} y={ff.location.y - s} width={s * 2} height={s * 2} transform={`rotate(45 ${ff.location.x} ${ff.location.y})`} className={`wfound ${on ? 'on' : ''}`} strokeWidth={1.5 * px} />
                  {label && <text x={ff.location.x} y={ff.location.y - s - 6 * px} fontSize={11 * px} textAnchor="middle" className="fmark-label found">{name}</text>}
                </g>
              );
            })}

            {/* Planner factories */}
            {placed.map((f) => {
              const on = sel?.kind === 'factory' && sel.id === f.id;
              const s = (on ? 11 : 8) * px;
              const b = f.game?.bounds;
              return (
                <g key={f.id} className="fmark" onPointerUp={click({ kind: 'factory', id: f.id })} onPointerEnter={() => setHoverName(`${f.name}${f.game ? ' · linked to your game' : ''}`)} onPointerLeave={() => setHoverName(null)}>
                  {b && <rect x={b.minX - 1500} y={b.minY - 1500} width={b.maxX - b.minX + 3000} height={b.maxY - b.minY + 3000} pointerEvents="none" className={`footprint linked ${on ? 'on' : ''}`} strokeWidth={1.2 * px} />}
                  <rect x={f.location!.x - s} y={f.location!.y - s} width={s * 2} height={s * 2} rx={2 * px} className={on ? 'fmark-active' : f.game ? 'fmark-linked' : 'fmark-other'} strokeWidth={2 * px} />
                  {(on || zoomedIn || placed.length <= 6) && <text x={f.location!.x} y={f.location!.y - s - 5 * px} fontSize={12 * px} textAnchor="middle" className="fmark-label">{f.name}</text>}
                </g>
              );
            })}
          </svg>
          <div className="map-hud">
            <span>{hoverName ?? (map.hover ? `x ${fmt(map.hover.x / 100, 0)} m, y ${fmt(map.hover.y / 100, 0)} m · scroll to zoom, drag to pan` : 'Scroll to zoom, drag to pan. Grid squares are 1 km.')}</span>
            <button className="small ghost" onClick={() => map.setVb(FULL_VIEW)}>Reset view</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FoundDetails({ ff, linked, onAdd, onOpen }: { ff: FoundFactory; linked: Factory | null; onAdd: () => void; onOpen: (id: string) => void }) {
  const { state, dispatch } = useStore();
  return (
    <section className="card world-detail">
      <div className="muted small-text">Built in your game</div>
      {linked ? <h3>{linked.name}</h3> : (
        <input className="rename" value={foundName(ff, state.foundNames)} onChange={(e) => dispatch({ type: 'renameFound', key: ff.key, name: e.target.value })} aria-label="Factory name" />
      )}
      <Makes ff={ff} />
      <div className="small-text muted">{ff.machines} machines · {mw(ff.built.power)} · {ff.nodes.length} mined node{ff.nodes.length === 1 ? '' : 's'}</div>
      {Object.keys(ff.extraSupply).length > 0 && (
        <div className="small-text"><span className="muted">From outside: </span>{Object.entries(ff.extraSupply).map(([i, v]) => <span key={i} className="nowrap"><ItemTag item={i} rate={v} /> </span>)}</div>
      )}
      <div className="row gap">
        {linked
          ? <button className="small" onClick={() => onOpen(linked.id)}>Open in planner</button>
          : <button className="small primary" onClick={onAdd}>Add to planner</button>}
      </div>
    </section>
  );
}

function FactoryDetails({ f, rate }: { f: Factory; rate: number | null }) {
  const { dispatch } = useStore();
  return (
    <section className="card world-detail">
      <div className="muted small-text">{f.game ? 'In the planner · linked to your game' : 'In the planner'}</div>
      <h3>{f.name}</h3>
      <div><ItemTag item={f.target} rate={rate ?? undefined} />{rate === null && <span className="muted small-text"> (no plan yet)</span>}</div>
      {f.game && (
        <div className="small-text muted">In game: {f.game.outputs.map(([i, v]) => amountName(i, v)).join(', ')}</div>
      )}
      <div className="row gap wrap">
        <button className="small" onClick={() => dispatch({ type: 'select', id: f.id, view: f.game ? 'built' : 'results' })}>{f.game ? 'Overview' : 'Results'}</button>
        <button className="small ghost" onClick={() => dispatch({ type: 'select', id: f.id, view: 'map' })}>Placement map</button>
      </div>
    </section>
  );
}
