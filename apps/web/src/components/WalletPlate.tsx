import { useMemo } from 'react';
import type { HullTemp, Pose, Tag } from '@aegis/pose';
import { PRIMARY_PRIORITY } from '@aegis/pose';
import { RISK_LABEL, TAG_LABEL, TAG_MEANING, hullSigilSvg, tagColor } from '@aegis/glyphs';

/*
 * WALLET PLATE — the hero of a wallet page, read like a lab spectral plate.
 *   left    the wallet's own sigil, coloured by its main type
 *   centre  energy levels: one line per type that fired on THIS wallet. The main type is the occupied line
 *           (bright, labelled, a dot on it); extra types are faint lines with no dot. Types that did not fire are
 *           not drawn. Each type always sits at the same height (its rule priority), so two plates compare at a glance.
 *   right   a vertical risk rail: SAFE at the bottom, WATCH, NEAR LIQUIDATION at the top, COULDN'T READ as a hollow
 *           mark off the rail. The dot's height is this wallet's risk. Nothing else.
 * Reads the pose already computed for the page; never reclassifies. No balances, HF or liquidation prices here —
 * those stay in sections 02, 04 and 05. Red appears only when this wallet is near liquidation (rail label + dot).
 */

/** Fixed height of every level, top = first in rule priority. Near liquidation is an overlay: it sits last. */
const LEVELS: readonly Tag[] = [...PRIMARY_PRIORITY, 'WOUNDED'];
const NEUTRAL = '#7E868B';

/** Main-type colour for the plate, never red (red is the rail's alone). */
function typeColor(t: Tag | null): string {
  if (!t || t === 'WOUNDED' || t === 'DARK' || t === 'EMPTY') return NEUTRAL;
  return tagColor(t);
}

type RailStop = 'CRITICAL' | 'ELEVATED' | 'NOMINAL';
const RAIL_Y: Record<RailStop, number> = { CRITICAL: 12, ELEVATED: 50, NOMINAL: 88 }; // % from the top
const DOT_COLOR: Record<HullTemp, string> = { NOMINAL: 'var(--cyan)', ELEVATED: 'var(--amber)', CRITICAL: 'var(--red)', UNKNOWN: 'var(--ink-dim)' };

export function WalletPlate({ address, pose, children }: { address: string; pose: Pose; children?: React.ReactNode }) {
  const state: 'DARK' | 'EMPTY' | 'NONE' | 'TYPED' =
    pose.primary === 'DARK' ? 'DARK' : pose.primary === 'EMPTY' ? 'EMPTY' : pose.primary === null && pose.tags.length === 0 ? 'NONE' : 'TYPED';
  const main = pose.primary;
  const rail = typeColor(main);
  // the sigil, coloured by main type — the "near liquidation" overlay never turns it red
  const sigil = useMemo(
    () =>
      hullSigilSvg(
        address,
        { primary: main === 'WOUNDED' ? null : main, tags: pose.tags.filter((t) => t !== 'WOUNDED'), hullTemp: pose.hullTemp },
        112,
      ),
    [address, main, pose.tags, pose.hullTemp],
  );
  const fired = new Set(pose.tags);
  const levels = state === 'TYPED' ? LEVELS.filter((t) => fired.has(t)) : [];
  // an empty wallet sits at SAFE; a wallet that couldn't be read has no position on the rail unless a readable venue
  // shows it near liquidation (that wound is real, so it is drawn)
  const stop: RailStop | null = state === 'EMPTY' ? 'NOMINAL' : pose.hullTemp === 'UNKNOWN' ? null : pose.hullTemp;
  const near = pose.hullTemp === 'CRITICAL';

  return (
    <section className="panel plate" style={{ ['--rail' as string]: rail }} data-testid="wallet-plate" aria-label="Wallet plate: position types and risk">
      <div className="rail" aria-hidden />
      <div className="body">
        <div className="plate-head">{children}</div>
        <div className="plate-grid">
          <div className="sigil plate-sigil" dangerouslySetInnerHTML={{ __html: sigil }} />

          <div className="plate-levels" data-testid="plate-levels">
            <div className="plate-cap">POSITION TYPE</div>
            {state === 'DARK' ? (
              <div className="plate-state" data-testid="primary-tag">Couldn't read</div>
            ) : state === 'EMPTY' ? (
              <div className="plate-state" data-testid="primary-tag">Empty</div>
            ) : state === 'NONE' ? (
              <div className="plate-state" data-testid="primary-tag">Unclassified</div>
            ) : (
              <div className="plate-field">
                {levels.map((t) => {
                  const isMain = t === main;
                  const y = 6 + (LEVELS.indexOf(t) / (LEVELS.length - 1)) * 88;
                  const c = typeColor(t);
                  return (
                    <div
                      key={t}
                      className={`plate-level${isMain ? ' main' : ''}`}
                      style={{ top: `${y}%`, ['--lc' as string]: c }}
                      title={TAG_MEANING[t]}
                      data-testid={isMain ? 'plate-main-level' : 'plate-level'}
                      data-tag={t}
                    >
                      <span className="plate-label" data-testid={isMain ? 'primary-tag' : undefined}>{TAG_LABEL[t]}</span>
                      <span className="plate-line" aria-hidden />
                      {isMain ? <span className="plate-dot" aria-hidden /> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="plate-rail" data-testid="plate-rail" data-risk={pose.hullTemp} aria-label={`Risk: ${RISK_LABEL[pose.hullTemp]}`}>
            <div className="plate-cap">RISK</div>
            <div className="plate-railbox">
              <span className="plate-spine" aria-hidden />
              {(['CRITICAL', 'ELEVATED', 'NOMINAL'] as const).map((s) => (
                <div key={s} className={`plate-stop${stop === s ? ' on' : ''}${s === 'CRITICAL' && near ? ' red' : ''}`} style={{ top: `${RAIL_Y[s]}%` }}>
                  <span className="plate-tick" aria-hidden />
                  <span className="plate-stop-label">{RISK_LABEL[s]}</span>
                </div>
              ))}
              {stop ? (
                <span className="plate-risk-dot" style={{ top: `${RAIL_Y[stop]}%`, background: DOT_COLOR[stop] }} data-testid="plate-risk-dot" data-stop={stop} aria-hidden />
              ) : null}
              <div className={`plate-off${pose.hullTemp === 'UNKNOWN' ? ' on' : ''}`} data-testid={pose.hullTemp === 'UNKNOWN' ? 'plate-risk-dot' : undefined} data-stop={pose.hullTemp === 'UNKNOWN' ? 'UNKNOWN' : undefined}>
                <span className="plate-hollow" aria-hidden />
                <span className="plate-stop-label">{RISK_LABEL.UNKNOWN}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
