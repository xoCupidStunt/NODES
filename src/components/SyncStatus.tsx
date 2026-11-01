import { useEffect, useState } from 'react';
import { useStore } from '../state';
import { useSaveSync } from '../sync/SaveSyncProvider';
import { ago } from './SaveSyncCard';

/** One-line sync state under the Progress button in the sidebar. */
export function SyncStatus() {
  const { state, dispatch } = useStore();
  const sync = useSaveSync();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(id);
  }, []);

  const open = () => dispatch({ type: 'view', view: 'progress' });
  let text: string;
  let cls = '';
  if (sync.busy) { text = `Reading save… ${Math.round(sync.busy.progress * 100)}%`; cls = 'busy'; }
  else if (sync.folder === 'needs-permission') { text = 'Click to resume game sync'; cls = 'attention'; }
  else if (sync.message?.tone === 'error') { text = 'Sync problem — see Progress'; cls = 'attention'; }
  else if (state.game) { text = `Synced ${ago(state.game.syncedAt)}`; cls = sync.folder === 'watching' && state.sync.auto ? 'live' : ''; }
  else text = 'Not synced with a save';

  return (
    <button className={`sync-status ${cls}`} onClick={sync.folder === 'needs-permission' ? sync.reconnect : open} title={state.game ? state.game.saveName : undefined}>
      <span className="sync-led" /> {text}
    </button>
  );
}
