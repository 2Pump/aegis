import { useRouteError } from 'react-router-dom';
import { COPY } from '@aegis/glyphs';
import { isStaleBuildError, reloadForNewBuild } from '../lib/staleBuild';

/** Shown instead of the router's developer page. A stale build (site updated while the tab was open) reloads itself once. */
export function AppError() {
  const err = useRouteError();
  const stale = isStaleBuildError(err);
  const reloading = stale && reloadForNewBuild();
  const msg = err instanceof Error ? err.message : String(err);
  return (
    <main className="stack" style={{ maxWidth: 720, paddingTop: 48 }}>
      <h2 className="page">AEGIS</h2>
      {reloading ? (
        <div className="banner cyan" data-testid="app-updating">AEGIS was just updated. Loading the new version…</div>
      ) : (
        <>
          <div className="banner red" data-testid="app-error">
            {stale ? 'AEGIS was updated while this page was open, and the reload did not pick it up.' : 'Something went wrong on this page.'}
          </div>
          <div className="mono dim" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{msg}</div>
          <div className="row">
            <button type="button" className="pill-btn" onClick={() => window.location.reload()}>Reload</button>
            <a className="pill-btn" href="/">Home</a>
          </div>
        </>
      )}
      <div className="faint mono" style={{ fontSize: 11, marginTop: 24 }}>{COPY.footer}</div>
    </main>
  );
}
