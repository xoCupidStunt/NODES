import { useMemo, useState } from 'react';
import { itemColor, itemName } from '../data/game';
import { previewSplit } from '../engine/grouping';
import { useStore } from '../state';
import { fmt, mw } from './ui';

/** Pick a gap and preview how a factory's machines split into separate factories. */
export function SeparatePanel({ machineIds, onApply, onCancel, applyLabel }: {
  machineIds: string[];
  onApply: (gap: number) => void;
  onCancel?: () => void;
  applyLabel: (parts: number) => string;
}) {
  const { state } = useStore();
  const [gap, setGap] = useState(60);
  const parts = useMemo(() => previewSplit(state, machineIds, gap), [state, machineIds, gap]);
  return (
    <div className="separate">
      <label className="fit-row wide">
        <span>Split where machines are more than</span>
        <input type="range" min={10} max={300} step={5} value={gap} onChange={(e) => setGap(Number(e.target.value))} />
        <span><b>{gap} m</b> apart</span>
      </label>
      {parts.length < 2 ? (
        <p className="muted small-text">At {gap} m everything stays together — try a smaller distance.</p>
      ) : (
        <div className="parts">
          {parts.map((p) => (
            <div key={p.key} className="part">
              <span className="swatch" style={{ background: itemColor(p.target) }} />
              <b>{fmt(p.rate)} {itemName(p.target)}</b>
              {p.built.outputs.length > 1 && <span className="muted"> +{p.built.outputs.length - 1} more</span>}
              <span className="muted"> · {p.machines} machine{p.machines > 1 ? 's' : ''} · {mw(p.built.power)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="row gap">
        <button className="small primary" disabled={parts.length < 2} onClick={() => onApply(gap)}>{applyLabel(parts.length)}</button>
        {onCancel && <button className="small ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
