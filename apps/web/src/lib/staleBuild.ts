/*
 * After a new deploy, a tab that was opened before it still points at the OLD build's file names. The first time it
 * lazy-loads a piece (the sphere, the 3D engine) that file is gone and the import fails ("Importing a module script
 * failed" on iPhone, "Failed to fetch dynamically imported module" elsewhere). The cure is one reload: the page then
 * gets the new build. A guard makes sure it is ONE reload — never a loop if something else is really broken.
 */

const KEY = 'aegis-stale-reload-at';
const GUARD_MS = 30_000;

export function isStaleBuildError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError|Loading chunk \d+ failed/i.test(msg);
}

/** Reloads the page once per 30 s. Returns true if a reload was started. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < GUARD_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // storage blocked (private mode): still reload once — the guard just can't be remembered
  }
  window.location.reload();
  return true;
}

/** Vite fires this when a lazy piece (or its CSS) can't be fetched. */
export function installStaleBuildReload(): void {
  window.addEventListener('vite:preloadError', (e) => {
    if (reloadForNewBuild()) e.preventDefault();
  });
}
