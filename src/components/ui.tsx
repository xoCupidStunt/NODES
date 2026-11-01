import { useMemo, useState } from 'react';
import { itemColor, items, type Item } from '../data/game';

export const fmt = (v: number, d = 2) => {
  if (!isFinite(v)) return '∞';
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return r.toLocaleString(undefined, { maximumFractionDigits: d });
};
export const mw = (v: number) => (v >= 1000 ? `${fmt(v / 1000, 2)} GW` : `${fmt(v, 1)} MW`);

export function Swatch({ item }: { item: string }) {
  return <span className="swatch" style={{ background: itemColor(item) }} aria-hidden />;
}

export function ItemTag({ item, rate, unitless }: { item: string; rate?: number; unitless?: boolean }) {
  const it = items[item];
  const fluid = it && it.form !== 'solid';
  return (
    <span className="item-tag">
      <Swatch item={item} />
      {rate !== undefined && <b>{fmt(rate)}{unitless ? '' : fluid ? ' m³' : ''}</b>} {it?.name ?? item}
    </span>
  );
}

export function ItemPicker({ value, options, onChange }: { value: string; options: Item[]; onChange: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.name.toLowerCase().includes(s)) : options;
  }, [q, options]);
  return (
    <div className="picker">
      <button className="picker-btn" onClick={() => setOpen(!open)}>
        <ItemTag item={value} /> <span className="caret">▾</span>
      </button>
      {open && (
        <div className="picker-pop">
          <input autoFocus placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="picker-list">
            {list.map((o) => (
              <button key={o.id} className={o.id === value ? 'on' : ''} onClick={() => { onChange(o.id); setOpen(false); setQ(''); }}>
                <ItemTag item={o.id} />
              </button>
            ))}
            {!list.length && <p className="muted pad">Nothing matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export function NumberInput({ value, onChange, min = 0, step = 1, placeholder, width = 90 }: {
  value: number | null; onChange: (v: number | null) => void; min?: number; step?: number; placeholder?: string; width?: number;
}) {
  return (
    <input
      type="number"
      style={{ width }}
      min={min}
      step={step}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Math.max(min, Number(e.target.value)))}
    />
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
