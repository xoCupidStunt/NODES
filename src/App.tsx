import { useRef } from 'react';
import { MapView } from './components/MapView';
import { ProgressPanel } from './components/ProgressPanel';
import { Results } from './components/Results';
import { SchematicView } from './components/SchematicView';
import { Setup } from './components/Setup';
import { itemName } from './data/game';
import { exportState, newFactory, parseImport, useStore, type View } from './state';
import { fmt } from './components/ui';
import { SyncStatus } from './components/SyncStatus';
import { WorldMap } from './components/WorldMap';
import { BuiltView } from './components/BuiltView';
import { useNewGameFactories } from './components/GameFactoriesCard';

const TABS: { id: View; label: string }[] = [
  { id: 'setup', label: '1 · Setup' },
  { id: 'map', label: '2 · Map & placement' },
  { id: 'results', label: '3 · Results' },
  { id: 'schematic', label: '4 · Schematic' },
];

export default function App() {
  const { state, dispatch, active, plans } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const newInGame = useNewGameFactories();
  const showGameFactories = () => {
    dispatch({ type: 'view', view: 'progress' });
    setTimeout(() => document.getElementById('game-factories')?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const doExport = () => {
    const blob = new Blob([exportState(state)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nodes-export.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const doImport = async (file: File) => {
    try {
      const data = parseImport(await file.text());
      dispatch({ type: 'load', state: { ...state, ...data, activeId: data.factories[0]?.id ?? null } });
    } catch (e) {
      alert(`Could not import: ${(e as Error).message}`);
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">N</span>
          <div>
            <div className="brand-title">N.O.D.E.S</div>
            <div className="brand-sub">Node Optimization &amp; Deployment Efficiency System</div>
          </div>
        </div>
        <button className={`nav ${state.view === 'progress' ? 'on' : ''}`} onClick={() => dispatch({ type: 'view', view: 'progress' })}>
          ⚙ Progress <span className="muted">Tier {state.progress.tier} · {state.progress.mam.length} MAM · {state.progress.alts.length} alts</span>
        </button>
        <SyncStatus />
        <button className={`nav ${state.view === 'world' ? 'on' : ''}`} onClick={() => dispatch({ type: 'showOnMap', focus: null })}>
          🗺 World map <span className="muted">All factories{state.game ? ' · planned and in game' : ''}</span>
        </button>
        <div className="side-head">
          <span>Factories</span>
          <button className="small" onClick={() => dispatch({ type: 'add', factory: newFactory(state.factories.length + 1) })}>+ New</button>
        </div>
        {newInGame > 0 && (
          <button className="small ingame-hint" onClick={showGameFactories}>⇩ {newInGame} factor{newInGame > 1 ? 'ies' : 'y'} found in your game</button>
        )}
        <div className="factory-list">
          {state.factories.length === 0 && <p className="muted pad">No factories yet. Click “+ New” to plan one.</p>}
          {state.factories.map((f) => {
            const p = plans[f.id];
            return (
              <button key={f.id} className={`factory-item ${f.id === state.activeId && state.view !== 'progress' && state.view !== 'world' ? 'on' : ''}`} onClick={() => dispatch({ type: 'select', id: f.id })}>
                <div className="fi-name">{f.name}{f.game && <span className="ingame-tag" title={f.game.missing ? "Not found in the last synced save" : "Linked to a factory in your save"}>{f.game.missing ? "gone?" : "in game"}</span>}</div>
                <div className="muted">
                  {p?.status === 'ok' ? `${fmt(p.rate)}/min ` : ''}{itemName(f.target)}
                  {f.location ? ' · placed' : ''}
                </div>
              </button>
            );
          })}
        </div>
        <div className="side-foot">
          <button className="small ghost" onClick={doExport}>Export</button>
          <button className="small ghost" onClick={() => fileRef.current?.click()}>Import</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
        </div>
      </aside>
      <main className="main">
        {state.view === 'world' ? (
          <WorldMap />
        ) : state.view === 'progress' || !active ? (
          state.view === 'progress' ? <ProgressPanel /> : <Welcome />
        ) : active.game && state.view === 'built' ? (
          <BuiltView f={active} />
        ) : (
          <>
            <header className="top">
              {active.game ? (
                <div className="built-title">
                  <button className="small ghost" onClick={() => dispatch({ type: 'view', view: 'built' })}>← Overview</button>
                  <b className="title-static">{active.name}</b>
                  <span className="ingame-tag">built in game</span>
                </div>
              ) : (
                <input className="title-input" value={active.name} onChange={(e) => dispatch({ type: 'update', id: active.id, patch: { name: e.target.value } })} aria-label="Factory name" />
              )}
              {active.game && state.view === 'schematic' ? (
                <span className="muted small-text">Build schematic for the best layout of this factory</span>
              ) : (
                <nav className="tabs">
                  {active.game && <span className="muted small-text">Planning changes:</span>}
                  {TABS.map((t) => (
                    <button key={t.id} className={state.view === t.id ? 'on' : ''} onClick={() => dispatch({ type: 'view', view: t.id })}>{t.label}</button>
                  ))}
                </nav>
              )}
            </header>
            <div className="content">
              {(state.view === 'setup' || state.view === 'built') && <Setup f={active} />}
              {state.view === 'map' && <MapView f={active} />}
              {state.view === 'results' && <Results f={active} />}
              {state.view === 'schematic' && <SchematicView f={active} />}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Welcome() {
  const { state, dispatch } = useStore();
  return (
    <div className="welcome">
      <h1>Welcome to N.O.D.E.S</h1>
      <p className="muted">Node Optimization &amp; Deployment Efficiency System — plan a Satisfactory factory from node to build.</p>
      <ol>
        <li>Set your <b>Progress</b> — tier, MAM research and hard-drive alternates — so only buildings and recipes you have are used.</li>
        <li>Create a factory, pick the product and how to optimise it.</li>
        <li>Place it on the map; the planner claims the nearest free resource nodes.</li>
        <li>Read the equipment list and clock settings, then generate a to-scale build schematic.</li>
      </ol>
      <button className="primary" onClick={() => dispatch({ type: 'add', factory: newFactory(state.factories.length + 1) })}>+ New factory</button>
    </div>
  );
}
