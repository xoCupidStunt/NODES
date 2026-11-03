import type { Tip } from '../engine/suggest';

/** One suggestion: title, a short reason, then either/or options (lettered) and/or steps in order (numbered). */
export function TipCard({ t }: { t: Tip }) {
  return (
    <div className={`tip ${t.kind}`}>
      <div className="tip-kind">{t.kind}</div>
      <div>
        <b>{t.title}</b>
        <div className="muted">{t.detail}</div>
        {t.options && t.options.length > 0 && (
          <div className="tip-options">
            <div className="tip-options-head">Choose one:</div>
            <ul>{t.options.map((o, j) => <li key={j}><span className="opt-or">{String.fromCharCode(65 + j)}</span>{o}</li>)}</ul>
          </div>
        )}
        {t.steps && t.steps.length > 0 && <ol className="tip-steps">{t.steps.map((s, j) => <li key={j}>{s}</li>)}</ol>}
      </div>
    </div>
  );
}
