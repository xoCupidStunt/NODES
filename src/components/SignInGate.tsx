import type { ReactNode } from 'react';
import { useCloud } from '../cloud/CloudProvider';
import { SignIn } from './AccountPanel';

/**
 * With online saves on, nothing is shown until someone signs in and their world is open, so nobody sees
 * plans left in this browser by someone else. Without online saves the app works as before.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  const c = useCloud();
  if (!c.enabled) return <>{children}</>;
  if (c.user && c.world) return <>{children}</>;

  let body: ReactNode;
  if (!c.authReady) body = <p className="muted">Loading…</p>;
  else if (!c.user) body = <SignIn />;
  else if (c.status !== 'loading' && c.error) {
    body = (
      <section className="card">
        <h2>Couldn’t open your world</h2>
        <p className="warn-text">{c.error ?? 'Something went wrong while loading.'}</p>
        <div className="row gap">
          <button className="primary" onClick={() => location.reload()}>Try again</button>
          <button className="ghost" onClick={() => void c.signOut()}>Sign out</button>
        </div>
      </section>
    );
  } else body = <p className="muted">Opening your world…</p>;

  return (
    <div className="gate">
      <div className="brand gate-brand">
        <span className="logo">N</span>
        <div>
          <div className="brand-title">N.O.D.E.S</div>
          <div className="brand-sub">Node Optimization &amp; Deployment Efficiency System</div>
        </div>
      </div>
      <div className="gate-body">{body}</div>
    </div>
  );
}
