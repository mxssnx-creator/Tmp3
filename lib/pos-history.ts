/**
 * Position (Pos) History — lifetime, atomic, hot-path-safe.
 *
 * Naming note: this module used to be called "PI history" / "Pi history",
 * which was a misnomer — every counter here tracks a closed POSITION,
 * not a "Pi". All exports were renamed: `PosHistoryStats`,
 * `recordPosClosed`, `getPosHistory`, `getPosHistoryOverall`,
 * `getPosHistoryBatch`, `bumpRealPosAccumulation`, `getRealPosAccumulation`,
 * `bumpAxisPosAccumulation`, `getAxisPosAccumulation`. Persisted Redis
 * key prefixes (`pi_history:`, `real_pi_acc:`, `axis_pos_acc:`) are
 * intentionally KEPT so existing live deployments do not silently drop
 * their accumulated history on deploy — the rename is code-side only.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────
 * The auto-indication engine reads a `position_history:*` blob to gate
 * its "optimal situation" check, and the strategy coordinator wants the
 * same realised performance signal to influence Base-stage PF blending
 * and Real-stage sizing/leverage. Neither a writer nor a structured key
 * existed before — the readers always saw "empty" and fell back to
 * neutral defaults. This module is that writer + a typed reader.
 *
 * ── KEY SHAPE ─────────────────────────────────────────────────────────
 * One Redis HASH per (connection, symbol, indicationType, direction):
 *
 *   pi_history:{conn}:{symbol}:{indicationType}:{direction}
 *
 * Fields (all integers — `hincrby` atomic, scaled where noted):
 *   count          total closed positions
 *   wins           closed with pnl > 0
 *   losses         closed with pnl <= 0
 *   pf_num_x1000   ∑ max(0, pnl)  × 1000  (gross profit, scaled)
 *   pf_den_x1000   ∑ max(0,-pnl)  × 1000  (gross loss,  scaled)
 *   ddt_num_x10    ∑ drawdown_minutes × 10
 *
 * Plus a connection-level "any direction / any type" rollup:
 *   pi_history:{conn}:_overall:_overall:_overall   (same fields)
 *
 * Why a hash instead of the legacy `position_history` blob: hincrby is
 * lock-free, immune to read-modify-write races between concurrent
 * closes, and lets every reader compute derived stats (success rate,
 * profit factor, avg DDT minutes) from cumulative integers without ever
 * loading per-position records. We never grow with N — bounded memory.
 *
 * The legacy `position_history:*` JSON blob is left untouched (still
 * read by other modules); writers there can decommission incrementally.
 */

import { getRedisClient } from "@/lib/redis-db"

// ── Constants ──────────────────────────────────────────────────────────
const TTL_SECONDS = 90 * 24 * 60 * 60 // 90 days — the run window we care about
const OVERALL_BUCKET = "_overall"

// ── Types ──────────────────────────────────────────────────────────────

export interface PosHistoryStats {
  /** Number of closed positions seen for this bucket. 0 means "no data". */
  count: number
  /** Wins / count, or 0 when count == 0. */
  successRate: number
  /**
   * Gross-profit / Gross-loss (classic profit factor).
   *  - 0 means "no data"
   *  - 99 means "all wins, no losses" (cap to keep blend math finite)
   */
  profitFactor: number
  /** Average drawdown minutes per closed position. */
  avgDDT: number
  /** Convenience flag — whether `count` clears the operator-tunable threshold. */
  hasSignal: boolean
}

const EMPTY: PosHistoryStats = {
  count: 0,
  successRate: 0,
  profitFactor: 0,
  avgDDT: 0,
  hasSignal: false,
}

// ── Key builders ───────────────────────────────────────────────────────
//
// NOTE: the persisted prefix is still `pi_history:` on purpose — see the
// header docstring. Renaming the prefix would orphan every live
// deployment's accumulated history. The code-side rename to `Pos`
// only touches identifiers and field/type names.

function hashKey(
  connectionId: string,
  symbol: string,
  indicationType: string,
  direction: string,
): string {
  return `pi_history:${connectionId}:${symbol}:${indicationType}:${direction}`
}

function overallKey(connectionId: string): string {
  return hashKey(connectionId, OVERALL_BUCKET, OVERALL_BUCKET, OVERALL_BUCKET)
}

// ── Writer ─────────────────────────────────────────────────────────────

export interface RecordPosClosedInput {
  connectionId: string
  symbol: string
  /** Indication type that originated the position (e.g. "direction" / "active" / "auto"). */
  indicationType: string
  direction: "long" | "short"
  /** Realised PnL in quote currency. Positive = win. */
  pnl: number
  /** Drawdown duration in minutes (best-effort, 0 ok). */
  drawdownMinutes?: number
  /**
   * Optional Redis pipeline. When provided we COMPOSE the writes into the
   * caller's existing pipeline so a single round-trip carries the full
   * close path (status flip + Pos history + Set append). When absent we
   * issue our own pipeline. Either way the ops are atomic w.r.t. each
   * other for a given close.
   */
  pipeline?: ReturnType<ReturnType<typeof getRedisClient>["multi"]>
}

/**
 * Record one CLOSED position into Pos history.
 *
 * Caller contract:
 *   • Call exactly once per close (closePosition path).
 *   • Provide best-effort `indicationType` / `direction` — empty strings
 *     are tolerated and bucketed under "unknown" rather than dropped, so
 *     legacy positions still contribute to the lifetime rollup.
 *
 * No throw — the catch-all is in the caller; we intentionally let the
 * pipeline.exec() failure (if any) propagate so callers using their own
 * pipeline observe the same atomicity story.
 */
export function recordPosClosed(input: RecordPosClosedInput): void {
  const {
    connectionId,
    symbol,
    indicationType,
    direction,
    pnl,
    drawdownMinutes = 0,
    pipeline: externalPipeline,
  } = input

  if (!connectionId) return

  const cleanSymbol = symbol || "unknown"
  const cleanType   = indicationType || "unknown"
  const cleanDir    =
    direction === "long" || direction === "short" ? direction : "unknown"

  const win  = pnl > 0
  const grossProfit = Math.max(0,  pnl)
  const grossLoss   = Math.max(0, -pnl)
  const ddt         = Math.max(0,  drawdownMinutes)

  // Scaled integer fields so every increment is a single atomic hincrby.
  // We round-down on the way in and divide on the way out — small per-
  // position rounding is acceptable because every reader operates on
  // cumulative ratios.
  const grossProfitX1000 = Math.round(grossProfit * 1000)
  const grossLossX1000   = Math.round(grossLoss   * 1000)
  const ddtX10           = Math.round(ddt * 10)

  const client = externalPipeline ?? getRedisClient().multi()
  const owned  = !externalPipeline

  // Per-bucket hash
  const k = hashKey(connectionId, cleanSymbol, cleanType, cleanDir)
  client.hincrby(k, "count",  1)
  client.hincrby(k, win ? "wins" : "losses", 1)
  if (grossProfitX1000 > 0) client.hincrby(k, "pf_num_x1000", grossProfitX1000)
  if (grossLossX1000   > 0) client.hincrby(k, "pf_den_x1000", grossLossX1000)
  if (ddtX10 > 0)           client.hincrby(k, "ddt_num_x10",  ddtX10)
  client.expire(k, TTL_SECONDS)

  // Connection-level rollup so callers that don't yet know the symbol/
  // type triple (e.g. dashboard "any-symbol prev-position" tile) still
  // see a useful aggregate. We keep both writes in the same pipeline so
  // the pair atomically stays consistent.
  const o = overallKey(connectionId)
  client.hincrby(o, "count",  1)
  client.hincrby(o, win ? "wins" : "losses", 1)
  if (grossProfitX1000 > 0) client.hincrby(o, "pf_num_x1000", grossProfitX1000)
  if (grossLossX1000   > 0) client.hincrby(o, "pf_den_x1000", grossLossX1000)
  if (ddtX10 > 0)           client.hincrby(o, "ddt_num_x10",  ddtX10)
  client.expire(o, TTL_SECONDS)

  if (owned) {
    // Fire-and-forget — caller didn't need atomicity with anything else.
    // Errors are intentionally swallowed: this is observability, not control.
    ;(client as any).exec().catch(() => {})
  }
}

// ── Reader ─────────────────────────────────────────────────────────────

function deriveStats(
  hash: Record<string, string> | null | undefined,
  threshold: number,
): PosHistoryStats {
  if (!hash) return EMPTY
  const count  = Number(hash.count  || "0")
  if (count <= 0) return EMPTY
  const wins   = Number(hash.wins   || "0")
  const num    = Number(hash.pf_num_x1000 || "0") / 1000
  const den    = Number(hash.pf_den_x1000 || "0") / 1000
  const ddtSum = Number(hash.ddt_num_x10  || "0") / 10
  const successRate = wins / count
  // Cap PF at 99 when den == 0 so "all wins" doesn't poison min-blend math.
  const profitFactor = den > 0 ? num / den : (num > 0 ? 99 : 0)
  const avgDDT = ddtSum / count
  return {
    count,
    successRate,
    profitFactor,
    avgDDT,
    hasSignal: count >= threshold,
  }
}

/**
 * Fetch the per-(symbol × type × direction) Pos history.
 *
 * Returns {count: 0, ...} when the bucket has no data — callers must
 * always be tolerant of "no signal yet" since fresh boots and new
 * symbol/direction pairs start empty.
 */
export async function getPosHistory(
  connectionId: string,
  symbol: string,
  indicationType: string,
  direction: "long" | "short",
  threshold = 5,
): Promise<PosHistoryStats> {
  try {
    const client = getRedisClient()
    const hash = (await client.hgetall(
      hashKey(connectionId, symbol, indicationType, direction),
    )) as Record<string, string>
    return deriveStats(hash, threshold)
  } catch {
    return EMPTY
  }
}

/** Connection-level rollup across all symbol/type/direction buckets. */
export async function getPosHistoryOverall(
  connectionId: string,
  threshold = 5,
): Promise<PosHistoryStats> {
  try {
    const client = getRedisClient()
    const hash = (await client.hgetall(overallKey(connectionId))) as Record<
      string,
      string
    >
    return deriveStats(hash, threshold)
  } catch {
    return EMPTY
  }
}

/**
 * Fetch many buckets in one round-trip. Used by createBaseSets to grab
 * (symbol × every (type, direction)) pair without N+1 hgetalls.
 */
export async function getPosHistoryBatch(
  connectionId: string,
  symbol: string,
  pairs: Array<{ indicationType: string; direction: "long" | "short" }>,
  threshold = 5,
): Promise<Map<string, PosHistoryStats>> {
  const out = new Map<string, PosHistoryStats>()
  if (pairs.length === 0) return out
  try {
    const client = getRedisClient()
    const pipeline = client.multi()
    for (const p of pairs) {
      pipeline.hgetall(hashKey(connectionId, symbol, p.indicationType, p.direction))
    }
    const results = (await (pipeline as any).exec()) as any[]
    pairs.forEach((p, i) => {
      const raw = results?.[i]
      // ioredis returns [err, value]; upstash returns the value directly.
      const hash = (Array.isArray(raw) ? raw[1] : raw) as
        | Record<string, string>
        | null
        | undefined
      out.set(`${p.indicationType}|${p.direction}`, deriveStats(hash, threshold))
    })
  } catch {
    /* return whatever we accumulated; missing entries default to EMPTY in callers */
  }
  return out
}

// ── Per-Base accumulation counter (Real-stage independence) ───────────
//
// At Real stage we need a per-Base, per-stage counter — the operator
// spec says "for each Base Set's positions cnts Sets … relying to their
// base sets configs INDEPENDENT". This is the persisted ledger backing
// the Strategy Pipeline UI's per-Base accumulation column.
//
// Persisted prefix kept as `real_pi_acc:` for backwards compatibility
// with already-running deployments — see header docstring.

/**
 * Increment the lifetime Real-stage Pos accumulation counter for a Base
 * Set. Composes into an external pipeline when provided, otherwise
 * fires its own one-shot pipeline.
 */
export function bumpRealPosAccumulation(
  connectionId: string,
  baseSetKey: string,
  delta = 1,
  externalPipeline?: ReturnType<ReturnType<typeof getRedisClient>["multi"]>,
): void {
  if (!connectionId || !baseSetKey || delta <= 0) return
  const key = `real_pi_acc:${connectionId}`
  const client = externalPipeline ?? getRedisClient().multi()
  client.hincrby(key, baseSetKey, delta)
  client.expire(key, TTL_SECONDS)
  if (!externalPipeline) {
    ;(client as any).exec().catch(() => {})
  }
}

/** Read full per-Base Real-stage accumulation map for the dashboard. */
export async function getRealPosAccumulation(
  connectionId: string,
): Promise<Record<string, number>> {
  try {
    const client = getRedisClient()
    const hash = (await client.hgetall(`real_pi_acc:${connectionId}`)) as Record<
      string,
      string
    >
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(hash || {})) out[k] = Number(v) || 0
    return out
  } catch {
    return {}
  }
}

// ── Per-axis-Set continuous-count ledger (Main "additional Pos-Count Sets") ───
//
// Operator spec: "the ongoing continuous count of positions. To be
// added, counted onto the new sets". Each Main axis Set (the
// prev × last × cont × outcome × dir Cartesian fan-out) needs its own
// rolling count of how many live continuous positions have actually
// accumulated onto it across cycles. Independent from
// `real_pi_acc:{conn}` (which is per-Base aggregate) so the dashboard
// can drill in to a specific axis bucket within a Base.
//
// Field key:  `${parentSetKey}|${axisKey}`
//   - parentSetKey isolates Bases (each Base Set has its own configs)
//   - axisKey already encodes (prev,last,cont,dir,outcome) tuple
//
// HASH per connection with hincrby semantics + sliding 90-day TTL,
// pipeline-friendly to be batched alongside the Real tuner's
// existing accumulation pipeline.

/**
 * Increment per-axis-Set continuous-count accumulation. Designed to be
 * called once per cycle per surviving axis Set with `delta` set to the
 * Set's current `entryCount` (= baseEC + min(cont, liveCont)). Composes
 * into an external pipeline when provided.
 */
export function bumpAxisPosAccumulation(
  connectionId: string,
  parentSetKey: string,
  axisKey: string,
  delta = 1,
  externalPipeline?: ReturnType<ReturnType<typeof getRedisClient>["multi"]>,
): void {
  if (!connectionId || !parentSetKey || !axisKey || delta <= 0) return
  const key = `axis_pos_acc:${connectionId}`
  const field = `${parentSetKey}|${axisKey}`
  const client = externalPipeline ?? getRedisClient().multi()
  client.hincrby(key, field, delta)
  client.expire(key, TTL_SECONDS)
  if (!externalPipeline) {
    ;(client as any).exec().catch(() => {})
  }
}

/** Read full per-axis accumulation map (for the Strategy Pipeline UI). */
export async function getAxisPosAccumulation(
  connectionId: string,
): Promise<Record<string, number>> {
  try {
    const client = getRedisClient()
    const hash = (await client.hgetall(`axis_pos_acc:${connectionId}`)) as Record<
      string,
      string
    >
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(hash || {})) out[k] = Number(v) || 0
    return out
  } catch {
    return {}
  }
}

// ── Valid Positions Counters ───────────────────────────────────────────
//
// Separate from Pos history: these track LIVE-promoted Sets (positions
// the engine considers "valid" — i.e. surviving Real and reaching Live).
// One HASH per connection with rollup fields the dashboard renders.

const VALID_POS_KEY = (connectionId: string) =>
  `valid_positions:${connectionId}`

export interface ValidPositionsBumpInput {
  connectionId: string
  symbol: string
  indicationType: string
  direction: "long" | "short"
  /**
   * Whether the Set is currently RUNNING (open / in-formation) on the
   * connection. Drives the `combined` (= active accumulation) field —
   * different from `overall` (= lifetime).
   */
  isRunningNow: boolean
  delta?: number
  /**
   * Optional pipeline to compose into. When provided we add commands
   * but DO NOT exec — caller is responsible for one combined exec.
   * This is the path used by the per-cycle Real tuner so a 30-symbol
   * burst writes once instead of 30 times.
   */
  externalPipeline?: ReturnType<ReturnType<typeof getRedisClient>["multi"]>
}

export function bumpValidPositions(input: ValidPositionsBumpInput): void {
  const { connectionId, symbol, indicationType, direction, isRunningNow, externalPipeline } = input
  const delta = input.delta ?? 1
  if (!connectionId || delta <= 0) return
  const k = VALID_POS_KEY(connectionId)
  const client = externalPipeline ?? getRedisClient().multi()
  client.hincrby(k, "overall", delta)
  if (isRunningNow) client.hincrby(k, "combined", delta)
  client.hincrby(k, `by_symbol:${symbol || "unknown"}`, delta)
  client.hincrby(k, `by_dir:${direction}`, delta)
  client.hincrby(k, `by_type:${indicationType || "unknown"}`, delta)
  client.expire(k, TTL_SECONDS)
  if (!externalPipeline) {
    ;(client as any).exec().catch(() => {})
  }
}

export interface ValidPositionsSnapshot {
  overall: number
  combined: number
  bySymbol: Record<string, number>
  byDirection: Record<string, number>
  byType: Record<string, number>
}

export async function getValidPositions(
  connectionId: string,
): Promise<ValidPositionsSnapshot> {
  if (!connectionId) {
    return {
      overall: 0,
      combined: 0,
      bySymbol: {},
      byDirection: { long: 0, short: 0 },
      byType: {},
    }
  }
  try {
    const client = getRedisClient()
    const k = VALID_POS_KEY(connectionId)
    const hash = await client.hgetall(k)
    
    // Debug: log what we got from Redis
    if (!hash || Object.keys(hash).length === 0) {
      console.log(`[v0] [PosHistory] getValidPositions(${connectionId}): empty hash from Redis key "${k}"`)
    }

    const h = hash || {}
    return {
      overall: Number(h.overall || 0),
      combined: Number(h.combined || 0),
      bySymbol: Object.fromEntries(
        Object.entries(h)
          .filter(([key]) => key.startsWith("by_symbol:"))
          .map(([key, val]) => [key.substring("by_symbol:".length), Number(val)]),
      ),
      byDirection: {
        long: Number(h["by_dir:long"] || 0),
        short: Number(h["by_dir:short"] || 0),
      },
      byType: Object.fromEntries(
        Object.entries(h)
          .filter(([key]) => key.startsWith("by_type:"))
          .map(([key, val]) => [key.substring("by_type:".length), Number(val)]),
      ),
    }
  } catch (err) {
    console.error(`[v0] [PosHistory] getValidPositions error:`, err)
    return {
      overall: 0,
      combined: 0,
      bySymbol: {},
      byDirection: { long: 0, short: 0 },
      byType: {},
    }
  }
}

// ── Per-Base hedge position-count accumulation (Real stage) ───────────
//
// Operator spec: "Do the accumulations for pos counts Sets at stage Real
// (hedging long, short for related same base Set)."
//
// For each Base Set, Real emits multiple derived Sets in both long and
// short directions (axis Cartesian + profile variants). This ledger
// accumulates the ENTRY COUNT (position-slots) per direction per Base
// Set so the engine can track the net hedge posture:
//
//   net = long_entries − short_entries
//   net > 0 → net-long bias   (more long positions than short)
//   net < 0 → net-short bias  (more short positions than long)
//   net = 0 → fully hedged    (equal long/short exposure)
//
// Key schema: `hedge_pos_acc:{conn}`  (one HASH per connection)
// Fields per base Set (parentSetKey):
//   `{parentSetKey}:long`   — cumulative entryCount from long Real Sets
//   `{parentSetKey}:short`  — cumulative entryCount from short Real Sets
//   `{parentSetKey}:sets_long`   — cumulative count of long Real Sets
//   `{parentSetKey}:sets_short`  — cumulative count of short Real Sets
//   `{parentSetKey}:ts`    — last-updated epoch ms (hset, not hincrby)
//
// All numeric fields use hincrby (atomic, no read-modify-write races).
// Composes into the caller's shared accPipeline so Real-stage overhead
// is zero added round-trips.

const HEDGE_ACC_KEY = (connectionId: string) => `hedge_pos_acc:${connectionId}`

export interface HedgePosAccumulationInput {
  connectionId: string
  /** parentSetKey = the Base Set this Real Set derives from. */
  parentSetKey: string
  direction: "long" | "short"
  /** Number of position-slots (entries) in this Real Set. */
  entryCount: number
  externalPipeline?: ReturnType<ReturnType<typeof getRedisClient>["multi"]>
}

/**
 * Accumulate position counts for a single Real Set into the per-Base
 * hedge ledger. Call once per Real Set in the tuner loop.
 *
 * - `entryCount` increments the directional entry total.
 * - Sets count increments separately so callers can derive average
 *   entries-per-set per direction.
 * - `ts` is refreshed with every call so readers know when the ledger
 *   was last written without a separate key.
 */
export function bumpHedgePosAccumulation(input: HedgePosAccumulationInput): void {
  const { connectionId, parentSetKey, direction, entryCount, externalPipeline } = input
  if (!connectionId || !parentSetKey || entryCount <= 0) return

  const key    = HEDGE_ACC_KEY(connectionId)
  const client = externalPipeline ?? getRedisClient().multi()
  const dir    = direction === "short" ? "short" : "long"

  client.hincrby(key, `${parentSetKey}:${dir}`,       entryCount)
  client.hincrby(key, `${parentSetKey}:sets_${dir}`,  1)
  client.hset(key,    `${parentSetKey}:ts`,           String(Date.now()))
  client.expire(key, TTL_SECONDS)

  if (!externalPipeline) {
    ;(client as any).exec().catch(() => {})
  }
}

export interface HedgePosSnapshot {
  parentSetKey: string
  longEntries:  number
  shortEntries: number
  longSets:     number
  shortSets:    number
  /** longEntries − shortEntries. Positive = net-long, negative = net-short. */
  net:          number
  /** Absolute net exposure as a fraction of total entries. 0 = fully hedged, 1 = all one side. */
  hedgeRatio:   number
  lastUpdated:  number
}

/**
 * Read the full hedge accumulation map for a connection.
 * Returns one snapshot per parentSetKey that has accumulated data.
 */
export async function getHedgePosAccumulation(
  connectionId: string,
): Promise<HedgePosSnapshot[]> {
  if (!connectionId) return []
  try {
    const client = getRedisClient()
    const hash = (await client.hgetall(HEDGE_ACC_KEY(connectionId))) as Record<string, string> | null
    if (!hash) return []

    // Group flat hash fields back into per-parentSetKey snapshots.
    // Fields: `{key}:long`, `{key}:short`, `{key}:sets_long`, `{key}:sets_short`, `{key}:ts`
    const byBase = new Map<string, {
      long: number; short: number
      setsLong: number; setsShort: number
      ts: number
    }>()

    for (const [field, rawVal] of Object.entries(hash)) {
      const val = Number(rawVal) || 0
      // Split on last `:` suffix to extract the base key and field suffix
      const colonIdx = field.lastIndexOf(":")
      if (colonIdx === -1) continue
      const baseKey = field.slice(0, colonIdx)
      const suffix  = field.slice(colonIdx + 1)

      let entry = byBase.get(baseKey)
      if (!entry) {
        entry = { long: 0, short: 0, setsLong: 0, setsShort: 0, ts: 0 }
        byBase.set(baseKey, entry)
      }
      if      (suffix === "long")       entry.long      = val
      else if (suffix === "short")      entry.short     = val
      else if (suffix === "sets_long")  entry.setsLong  = val
      else if (suffix === "sets_short") entry.setsShort = val
      else if (suffix === "ts")         entry.ts        = val
    }

    const out: HedgePosSnapshot[] = []
    for (const [parentSetKey, e] of byBase) {
      const total = e.long + e.short
      out.push({
        parentSetKey,
        longEntries:  e.long,
        shortEntries: e.short,
        longSets:     e.setsLong,
        shortSets:    e.setsShort,
        net:          e.long - e.short,
        hedgeRatio:   total > 0 ? Math.abs(e.long - e.short) / total : 0,
        lastUpdated:  e.ts,
      })
    }
    // Sort: most-imbalanced (largest |net|) first so dashboards surface the biggest exposures
    out.sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    return out
  } catch {
    return []
  }
}
