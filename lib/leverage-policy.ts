/**
 * ─────────────────────────────────────────────────────────────────────
 *  Leverage policy — "always use max leverage, everywhere"
 * ─────────────────────────────────────────────────────────────────────
 *
 *  Operator policy: when actually opening positions on the venue (Live
 *  stage, manual trades, the live-orders test harness, balance-test
 *  fallbacks), ALWAYS request the connection's *maximum supported*
 *  leverage. Strategy-derived per-variant `leverage` values are an
 *  internal coordination signal — they MUST NOT escape into venue
 *  calls.
 *
 *  Why a single helper:
 *  ────────────────────
 *   • A single source of truth (CONNECTION_PREDEFINITIONS.maxLeverage)
 *     keeps spot-checks predictable and removes the dozen scattered
 *     "leverage: 1" / "leverage: 150" magic numbers across the
 *     codebase.
 *   • Connections may be unknown / mock (test harness, dev sandboxes).
 *     The helper gracefully returns a safe default (10x) so callers
 *     never crash on venue lookup failure.
 *   • The two BingX safety paths — venue-quoted leverage cap on the
 *     symbol and the volume calculator's balance-based cap — still
 *     run AFTER this helper, so we never violate exchange limits even
 *     when the predefinition says 150x.
 *
 *  Order of precedence at order time:
 *     1.  Helper returns predefinition.maxLeverage (e.g. BingX → 150).
 *     2.  setLeverage(symbol, X) on the connector — venue clamps to
 *         the per-symbol bracket if X exceeds it.
 *     3.  Volume calculator's balance-based cap clamps the per-order
 *         leverage further when the account is small (≤$50 → 10x,
 *         ≤$200 → 20x, ≤$500 → 50x, otherwise 125x).
 *     4.  101204 ("Insufficient margin") fallback halves leverage
 *         and retries once (live-stage already implements this).
 *
 *  Net effect: callers get "max leverage" semantics without having to
 *  implement balance/symbol clamps themselves; safety nets stay armed.
 *
 *  Safe default (`SAFE_DEFAULT_MAX_LEVERAGE = 10`):
 *    Used when the connection cannot be resolved (e.g. no DB row
 *    matching `connectionId`, predefinition lookup miss, or ID is a
 *    test stub like "test-conn"). 10x is the floor of the
 *    balance-based cap chain above, so the resulting margin
 *    requirement is always satisfiable on accounts ≥$50.
 */

import {
  getPredefinedConnectionsAsStatic,
  type ConnectionPredefinition,
} from "./connection-predefinitions"

const SAFE_DEFAULT_MAX_LEVERAGE = 10

/** Lookup table built once on module load (predefinitions are static). */
const PREDEF_BY_EXCHANGE: ReadonlyMap<string, ConnectionPredefinition> =
  (() => {
    const m = new Map<string, ConnectionPredefinition>()
    for (const p of getPredefinedConnectionsAsStatic()) {
      // Predefinitions are unique per exchange — last write wins by
      // design (later predefinitions override earlier ones if the
      // table is ever extended with regional variants).
      m.set(p.exchange.toLowerCase(), p)
    }
    return m
  })()

/**
 * Resolve the maximum supported leverage for the given exchange code
 * (e.g. "bingx", "binance", "bybit"). Returns SAFE_DEFAULT_MAX_LEVERAGE
 * when the exchange is unknown so callers can never receive a negative
 * or zero leverage value.
 *
 * Pure / synchronous — safe to call from any code path including hot
 * order-placement loops. No I/O.
 */
export function getMaxLeverageForExchange(
  exchange: string | undefined | null,
): number {
  if (!exchange) return SAFE_DEFAULT_MAX_LEVERAGE
  const predef = PREDEF_BY_EXCHANGE.get(exchange.toLowerCase())
  if (!predef || !Number.isFinite(predef.maxLeverage) || predef.maxLeverage < 1) {
    return SAFE_DEFAULT_MAX_LEVERAGE
  }
  return Math.floor(predef.maxLeverage)
}

/**
 * Resolve max leverage for a connection-by-id. Hits the connections
 * store ONCE; falls back to SAFE_DEFAULT_MAX_LEVERAGE if the connection
 * cannot be resolved (e.g. test stubs, deleted connections). Designed
 * for non-hot paths — the live stage's `placeLiveOrder` already has
 * the connection in scope and should call `getMaxLeverageForExchange`
 * directly with `connection.exchange` to avoid a redundant lookup.
 */
export async function getMaxLeverageForConnection(
  connectionId: string,
): Promise<number> {
  try {
    const { getConnection } = await import("./redis-db")
    const connection = await getConnection(connectionId)
    return getMaxLeverageForExchange(connection?.exchange)
  } catch {
    return SAFE_DEFAULT_MAX_LEVERAGE
  }
}
