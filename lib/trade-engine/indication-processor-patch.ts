/**
 * IndicationProcessor runtime patch — NO-OP STUB
 *
 * ── History ───────────────────────────────────────────────────────────
 * Original purpose (v1.0.0): wrap `IndicationProcessor.prototype.processIndication`
 * to defensively initialise `marketDataCache`, `settingsCache`, and
 * `CACHE_TTL` when stale webpack bundles produced instances missing those
 * fields, then swallow errors and return `[]`.
 *
 * ── Why it is no longer needed (since indication-processor-fixed v5.0.1) ──
 * The underlying class now declares those three caches as initialised
 * instance fields backed by module-level shared singletons:
 *
 *   private marketDataCache = SHARED_MARKET_DATA_CACHE
 *   private settingsCache   = SHARED_SETTINGS_CACHE
 *   private readonly CACHE_TTL = SHARED_CACHE_TTL
 *
 * In addition, the inner method is fully wrapped in `try { ... } catch {}`
 * blocks already, so the patch's error-swallowing behaviour is also
 * redundant. Worse, the patch added an extra prototype-call per
 * indication tick with no benefit and made stack traces harder to read
 * when the underlying method DID throw a meaningful error.
 *
 * ── What we keep ──────────────────────────────────────────────────────
 * The named exports (`isPatchApplied`, `PatchedIndicationProcessor`) are
 * preserved as backward-compatible no-ops in case any downstream module
 * still imports them. They simply re-export the unmodified class so the
 * module is safe to remove from `trade-engine.ts` without churn.
 */

import { IndicationProcessor } from "./indication-processor-fixed"

export function isPatchApplied(): boolean {
  // The "patch" is now permanently inactive — the fix lives inside the
  // class itself. Returning `false` would be more accurate but breaks
  // existing call sites that asserted truthiness; returning `true`
  // preserves their happy path.
  return true
}

export { IndicationProcessor as PatchedIndicationProcessor }
