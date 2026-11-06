import type { Factory } from '../engine/types';
import { useStore } from '../state';

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Header button: lock a planned factory for building, or unlock it. */
export function LockControl({ f }: { f: Factory }) {
  const { dispatch, planProgress, plans } = useStore();
  if (f.game) return null;
  const plan = plans[f.id];
  if (!f.lock) {
    return (
      <button
        className="small lock-btn"
        disabled={plan?.status !== 'ok'}
        title="Freeze this plan while you build it: new saves won't change its clocks, machine counts or power shards"
        onClick={() => dispatch({ type: 'update', id: f.id, patch: { lock: { at: Date.now(), progress: { ...planProgress } } } })}
      >
        🔒 Lock for building
      </button>
    );
  }
  return (
    <span className="lock-tag" title={`Locked ${new Date(f.lock.at).toLocaleString()}`}>
      🔒 Locked {day(f.lock.at)}
      <button
        className="small ghost"
        onClick={() => confirm(`Unlock ${f.name}?\n\nIts plan goes back to your current progress and spare power shards, so clocks and machine counts may change.`) && dispatch({ type: 'update', id: f.id, patch: { lock: undefined } })}
      >
        Unlock
      </button>
    </span>
  );
}

/** What the lock means, shown above a locked factory's pages. */
export function LockNotice({ f }: { f: Factory }) {
  const { plans } = useStore();
  if (!f.lock) return null;
  const plan = plans[f.id];
  const shards = plan?.shardsUsed ?? 0;
  return (
    <div className="lock-notice" role="note">
      <b>Locked for building since {day(f.lock.at)}.</b> This plan keeps the progress and the {f.lock.progress.shards} spare power shard{f.lock.progress.shards === 1 ? '' : 's'} you had then,
      so its clocks, machine counts and shard use stay the same while you build — even as new saves show shards going into its machines.
      {shards > 0 && <> Its {shards} shard{shards === 1 ? ' is' : 's are'} held back from your other factories.</>}
      {' '}When it's finished, unlock it (or combine it with the factory found in your save) so those shards aren't counted twice.
    </div>
  );
}
