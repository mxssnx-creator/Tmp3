/**
 * Strategy Coordinator - Progressive Strategy Flow
 * Coordinates the progression from BASE → MAIN → REAL → LIVE with proper evaluation metrics
 *
 * Flow:
 * 1. BASE: Create one strategy Set per (indication_type × direction) combination
 *          Each Set holds up to 250 config entries. Count = number of Sets.
 * 2. MAIN: Select Sets where avgProfitFactor >= 1.2 (from base).
 *          Expand each Set with position-size / leverage config variants.
 *          Max 250 entries per Set; rearrange by performance when over limit.
 * 3. REAL: Select Sets where avgProfitFactor >= 1.4 (from main).
 *          Exchange-mirrored high-confidence strategies.
 * 4. LIVE: Select best 500 Sets (ranked by profitFactor) for real trading.
 *          One pseudo position per (indication_type, direction) Set.
 *
 * Strategy counts always represent the number of SETS, not individual pseudo positions.
 */

import { initRedis, getSettings, setSettings, getRedisClient } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { PositionThresholdManager } from "@/lib/position-threshold-manager"
import { PseudoPositionManager } from "@/lib/trade-engine/pseudo-position-manager"
import {
  compact,
  loadCompactionConfig,
  type CompactionConfig,
} from "@/lib/sets-compaction"

export interface EvaluationMetrics {
  maxDrawdownTime: number
  minProfitFactor: number
  confidence: number
  description: string
}

export interface StrategyEvaluation {
  type: "base" | "main" | "real" | "live"
  symbol: string
  timestamp: Date
  totalCreated: number      // number of Sets created/evaluated
  passedEvaluation: number  // number of Sets that passed the filter
  failedEvaluation: number  // number of Sets that failed
  avgProfitFactor: number
  avgDrawdownTime: number
}

// One Set = one unique (indication_type × direction) combination at BASE.
// At MAIN we additionally produce related variant Sets derived from a parent
// Base Set — these carry `parentSetKey` (=> the Base Set they derive from)
// and `variant` (=> default / trailing / block / dca). REAL and LIVE stages
// treat them uniformly alongside base-promoted Sets.
export interface StrategySet {
  setKey: string            // e.g. "direction:long" (Base) or "direction:long#block" (Main variant)
  indicationType: string
  direction: "long" | "short"
  avgProfitFactor: number
  avgConfidence: number
  avgDrawdownTime: number
  entryCount: number        // number of config entries in this set (max 250)
  entries: StrategySetEntry[]
  createdAt: string
  // Lineage — populated at MAIN stage; preserved through REAL/LIVE
  parentSetKey?: string
  variant?: "default" | "trailing" | "block" | "dca" | "pause"
  /**
   * ── Position-count axis windows that this Set satisfies ────────────
   *
   * Spec: *"the created additional related Sets based on Pos counts.. step 1
   * previous 1-12; Last (of previous) 1-4; continuous 1-8 and Pause 1-8
   * so for each validated Base Set.. additional related cnt Sets of > 1000
   * are created and async Calculated.. handled."*
   *
   * Each component records the **integer window** the Set was generated
   * under. We clamp to spec maxima:
   *   - prev   : 0..12  (closed lookback, ctx.prevPosCount)
   *   - last   : 0..4   (the magnitude of last-N wins or losses dimension)
   *   - cont   : 0..8   (open continuous positions, ctx.continuousCount)
   *   - pause  : 0..8   (last-N validation window, ctx.lastPosCount)
   *
   * 0 means "axis not active for this Set" — we still emit it so consumers
   * can dimensionalise stats by axis without re-deriving from ctx.
   *
   * Block + DCA Sets are **independent of these axes** (they fire on
   * `continuousCount >= 1` and `prevLosses >= 1` respectively, which
   * are intrinsic to the variant gates, not on a tagged window). Their
   * axisWindows are still emitted (with `prev`/`pause` populated from
   * ctx, `cont`/`last` left at 0) so the dashboard's per-variant
   * counter blocks can roll up cleanly without special-casing.
   */
  axisWindows?: {
    prev:  number
    last:  number
    cont:  number
    pause: number
  }
}

export interface StrategySetEntry {
  id: string
  sizeMultiplier: number
  leverage: number
  positionState: string
  profitFactor: number
  drawdownTime: number
  confidence: number
}

/**
 * Per-cycle position coordination context used by MAIN to decide which
 * additional variant Sets to produce. Fetched ONCE per cycle (via
 * getPositionContext) and threaded through so Base/Main/Real each see the
 * same snapshot without duplicating Redis round-trips.
 */
export interface PositionContext {
  /** Currently-open pseudo positions on the exchange (continuous) */
  continuousCount: number
  /** Count of the most recent N closed positions (default last 5) */
  lastPosCount: number
  /** Total closed positions in the lookback window (default 24h) */
  prevPosCount: number
  /** Number of winners among the last N closed */
  lastWins: number
  /** Number of losers among the last N closed */
  lastLosses: number
  /** Total losers in the lookback window — gates DCA recovery variants */
  prevLosses: number
  /** Per-symbol open position count (for symbol-scoped variant decisions) */
  perSymbolOpen: Record<string, number>
}

export interface StrategyCoordinatorConfig {
  maxEntriesPerSet?: number   // Default 250 (entries inside one Set)
  maxLiveSets?: number        // Default 500 (Sets eligible for live trading)
  pruneStrategy?: "fifo" | "performance" | "hybrid"
}

export class StrategyCoordinator {
  private connectionId: string
  private config: StrategyCoordinatorConfig = {
    maxEntriesPerSet: 250,
    maxLiveSets: 500,
    pruneStrategy: "hybrid",
  }

  // Profit factor thresholds per stage
  private readonly PF_BASE_MIN = 1.0    // Minimum to enter BASE set
  private readonly PF_MAIN_MIN = 1.2    // Base sets must have avgPF >= 1.2 to enter MAIN
  private readonly PF_REAL_MIN = 1.4    // Main sets must have avgPF >= 1.4 to enter REAL
  private readonly PF_LIVE_MIN = 1.4    // Real sets must have avgPF >= 1.4 to enter LIVE

  // ── Filter axes (P0-2) ──────────────────────────────────────────────
  // Spec: *"filtering by Profitfactor Minimum, DrawdownTime Maximum"*.
  // The canonical Main/Real/Live filter axes are PF-min + DDT-max ONLY.
  // `confidence` is retained here as advisory metadata (it's shown in
  // diagnostic logs and used by the Live stage's trailing-variant
  // selector `bestEntry.confidence >= 0.85`), but it is NOT a filter
  // axis at any stage. The filter code below reads `minProfitFactor`
  // and `maxDrawdownTime` only.
  private readonly METRICS: Record<string, EvaluationMetrics> = {
    base: {
      maxDrawdownTime: 999999,
      minProfitFactor: 1.0,
      confidence: 0.3,  // advisory only
      description: "One Set per (indication_type × direction) — all qualifying",
    },
    main: {
      maxDrawdownTime: 1440,  // 24 hours
      minProfitFactor: 1.2,   // Base sets with avgPF >= 1.2 → promoted to MAIN
      confidence: 0.5,        // advisory only
      description: "Sets promoted from BASE with profitFactor >= 1.2 + DDT <= 24h",
    },
    real: {
      maxDrawdownTime: 960,   // 16 hours
      minProfitFactor: 1.4,   // Main sets with avgPF >= 1.4 → promoted to REAL
      confidence: 0.65,       // advisory only
      description: "Sets promoted from MAIN with profitFactor >= 1.4 + DDT <= 16h",
    },
    live: {
      maxDrawdownTime: 120,   // 2 hours — realistic for current strategy output
      minProfitFactor: 1.4,   // Match REAL stage minimum so Sets can flow through
      confidence: 0.65,       // advisory only
      description: "Best 500 Sets from REAL (PF >= 1.4 + DDT <= 2h) ready for live trading",
    },
  }

  constructor(connectionId: string, config?: StrategyCoordinatorConfig) {
    this.connectionId = connectionId
    if (config) {
      this.config = { ...this.config, ...config }
    }
  }

  /**
   * Execute complete strategy progression flow.
   *
   * Position context is fetched ONCE per cycle and threaded through so Main
   * can generate the correct additional variant Sets without duplicating
   * pseudo-position reads. Callers may also pass a precomputed context
   * (e.g. when running multiple symbols in the same cycle) — we'll reuse it.
   */
  async executeStrategyFlow(
    symbol: string,
    indications: any[],
    isPrehistoric: boolean = false,
    sharedContext?: PositionContext,
  ): Promise<StrategyEvaluation[]> {
    const results: StrategyEvaluation[] = []

    try {
      // Fetch the per-cycle position coordination context once. Prehistoric
      // runs use a neutral context (no open positions, no prior outcomes) so
      // only the always-on `default` variant is produced — that matches the
      // original behaviour for backtests.
      const posCtx: PositionContext = sharedContext
        ?? (isPrehistoric
          ? this.neutralPositionContext()
          : await this.getPositionContext())

      // Sets flow BASE → MAIN → REAL → LIVE. Each stage used to re-read its
      // predecessor's output from Redis via getSettings(); we now pipe the
      // computed arrays directly between stages in memory to eliminate 3
      // Redis round-trips per symbol per cycle. Each stage still persists
      // its own output to Redis for downstream consumers (stats API, dashboard).
      //
      // STAGE 1: BASE — one Set per (indication_type × direction)
      const { result: baseResult, sets: baseSets } = await this.createBaseSets(symbol, indications)
      results.push(baseResult)

      // STAGE 2: MAIN — validate Base Sets AND create additional related
      // variant Sets (Default / Trailing / Block / DCA) gated by posCtx.
      const { result: mainResult, sets: mainSets } = await this.createMainSets(symbol, baseSets, posCtx)
      results.push(mainResult)

      // STAGE 3: REAL — promote Sets with avgPF >= 1.4 (base-promoted AND
      // additional related variants flow uniformly through this filter)
      const { result: realResult, sets: realSets } = await this.evaluateRealSets(symbol, mainSets)
      results.push(realResult)

      // STAGE 4: LIVE — best 500 Sets for execution (skip in prehistoric mode)
      if (!isPrehistoric) {
        const { result: liveResult } = await this.createLiveSets(symbol, realSets)
        results.push(liveResult)
      }

      await this.logStrategyProgression(symbol, results)
      return results
    } catch (error) {
      console.error(`[v0] [StrategyCoordinator] Flow failed for ${symbol}:`, error)
      throw error
    }
  }

  /**
   * Run N symbols in a single flow pass, sharing one position-context fetch
   * across all of them. Use this when the engine evaluates many symbols per
   * cycle — it eliminates (N-1) pseudo-position reads vs. calling
   * `executeStrategyFlow` separately for each symbol.
   */
  async executeStrategyFlowBatch(
    items: Array<{ symbol: string; indications: any[] }>,
    isPrehistoric: boolean = false,
  ): Promise<Record<string, StrategyEvaluation[]>> {
    const ctx = isPrehistoric ? this.neutralPositionContext() : await this.getPositionContext()
    const out: Record<string, StrategyEvaluation[]> = {}
    // Run per-symbol flows in parallel — they only share the ctx snapshot and
    // each touches distinct symbol-scoped Redis keys.
    await Promise.all(
      items.map(async ({ symbol, indications }) => {
        out[symbol] = await this.executeStrategyFlow(symbol, indications, isPrehistoric, ctx)
      }),
    )
    return out
  }

  // ─── STAGE 1: BASE ───────────────────────────────────────────────────────────

  /**
   * Create one StrategySet per (indication_type × direction) combination.
   * Each Set holds multiple config entries (max 250), but counts as 1 Set.
   */
  private async createBaseSets(
    symbol: string,
    indications: any[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    // Group indications by (type × direction)
    const setMap = new Map<string, { indicationType: string; direction: "long" | "short"; indications: any[] }>()

    for (const ind of indications) {
      const direction: "long" | "short" = ind.metadata?.direction === "short" ? "short" : "long"
      const key = `${ind.type || "direction"}:${direction}`
      if (!setMap.has(key)) {
        setMap.set(key, { indicationType: ind.type || "direction", direction, indications: [] })
      }
      setMap.get(key)!.indications.push(ind)
    }

    const baseSets: StrategySet[] = []
    const maxEntries = this.config.maxEntriesPerSet || 250

    for (const [setKey, group] of setMap.entries()) {
      // Build up to maxEntries config entries for this Set
      const entries: StrategySetEntry[] = []
      let entryIdx = 0

      for (const ind of group.indications) {
        if (entryIdx >= maxEntries) break
        // Always parse as numbers — indication fields may arrive as strings from Redis hgetall
        const rawConf = parseFloat(String(ind.confidence ?? 0.5))
        const conf = Number.isFinite(rawConf) ? rawConf : 0.5
        const rawPF = parseFloat(String(ind.profitFactor ?? ind.profit_factor ?? 0))
        const pfFromPF = Number.isFinite(rawPF) && rawPF > 0 ? rawPF : conf * 2
        const pf = pfFromPF
        if (pf < this.PF_BASE_MIN) continue

        entries.push({
          id: `${setKey}-${entryIdx}`,
          sizeMultiplier: 1.0,
          leverage: 1,
          positionState: "new",
          profitFactor: pf,
          drawdownTime: 0,
          confidence: conf,
        })
        entryIdx++
      }

      if (entries.length === 0) continue

      const avgPF = entries.reduce((s, e) => s + e.profitFactor, 0) / entries.length
      const avgConf = entries.reduce((s, e) => s + e.confidence, 0) / entries.length

      const set: StrategySet = {
        setKey,
        indicationType: group.indicationType,
        direction: group.direction,
        avgProfitFactor: avgPF,
        avgConfidence: avgConf,
        avgDrawdownTime: 0,
        entryCount: entries.length,
        entries,
        createdAt: new Date().toISOString(),
      }

      baseSets.push(set)
    }

    // Persist BASE sets
    const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
    await setSettings(baseKey, { sets: baseSets, count: baseSets.length, created: new Date() })

    // Write Base counts to progression hash so stats API and dashboard read accurate per-stage counts.
    // CRITICAL: Use hincrby (cumulative) not hset (snapshot). Previously each cycle overwrote the
    // value with the current cycle's count, which made the dashboard oscillate between high/low
    // values every few seconds ("jumping more and less"). The per-cycle snapshot is still
    // available in `strategy_detail:{connId}:base` (`created_sets` field).
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const detailKey  = `strategy_detail:${this.connectionId}:base`
      const baseAvgPF  = baseSets.length > 0 ? baseSets.reduce((s, st) => s + st.avgProfitFactor, 0) / baseSets.length : 0
      const baseAvgDDT = baseSets.length > 0 ? baseSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / baseSets.length : 0
      // Average config entries per Set — the canonical "positions per Set"
      // metric the dashboard surfaces for each stage. At Base, each entry is
      // one raw indication slot ready for position coordination at Main.
      const baseEntriesTotal  = baseSets.reduce((s, st) => s + (st.entryCount || 0), 0)
      const baseAvgPosPerSet  = baseSets.length > 0 ? baseEntriesTotal / baseSets.length : 0

      // Fan-out all independent writes. The awaited chain used to add ~8 Redis
      // round-trips to every BASE cycle even when nothing had changed; issuing
      // them concurrently cuts that to a single bounded round-trip window.
      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_base_current", String(baseSets.length)),
        client.expire(redisKey, 7 * 24 * 60 * 60),
        client.hset(detailKey, {
          created_sets:      String(baseSets.length),
          avg_profit_factor: String(baseAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(baseAvgDDT)),
          avg_pos_per_set:   String(baseAvgPosPerSet.toFixed(2)),
          evaluated:         String(baseSets.length),
          passed_sets:       "0",   // will be updated by createMainSets
          entries_total:     String(baseEntriesTotal),
          updated_at:        String(Date.now()),
        }),
        client.expire(detailKey, 86400),
        client.set(`strategies:${this.connectionId}:base:count`, String(baseSets.length)),
        client.set(`strategies:${this.connectionId}:base:evaluated`, String(baseSets.length)),
        client.expire(`strategies:${this.connectionId}:base:count`, 86400),
        client.expire(`strategies:${this.connectionId}:base:evaluated`, 86400),
      ]
      if (baseSets.length > 0) {
        writes.push(client.hincrby(redisKey, "strategies_base_total", baseSets.length))
        writes.push(client.hincrby(redisKey, "strategies_base_evaluated", baseSets.length))
      }
      await Promise.all(writes)
    } catch { /* non-critical */ }

    console.log(`[v0] [StrategyFlow] ${symbol} BASE: ${baseSets.length} Sets created (${baseSets.reduce((s, set) => s + set.entryCount, 0)} total entries)`)

    return {
      result: {
        type: "base",
        symbol,
        timestamp: new Date(),
        totalCreated: baseSets.length,
        passedEvaluation: baseSets.length,
        failedEvaluation: 0,
        avgProfitFactor: baseSets.length > 0 ? baseSets.reduce((s, set) => s + set.avgProfitFactor, 0) / baseSets.length : 0,
        avgDrawdownTime: 0,
      },
      sets: baseSets,
    }
  }

  // ─── STAGE 2: MAIN ───────────────────────────────────────────────────────────

  /**
   * Validate BASE Sets (avgPF >= 1.2, avgConf >= 0.5, DDT <= 24h) AND create
   * additional RELATED variant Sets for each validated Base Set, gated by
   * per-cycle position coordination context.
   *
   * Per user spec:
   *   "Main validates from Base Sets, then creates additional related Sets
   *    (based on prev pos counts, last pos counts, continuous pos counts,
   *    each with adjusted strategies — Block, DCA, etc.) for each evaluated
   *    Set, IF NOT ALREADY CREATED, and are used for continuous progress to
   *    Real. Real evaluates from Main with the additional related Sets."
   *
   * Implementation:
   *   1. For each Base Set passing validation, produce N "related" Main Sets,
   *      one per ACTIVE variant whose gate predicate passes for the current
   *      PositionContext. Each related Set carries `parentSetKey` = base
   *      setKey + `variant` = one of {default, trailing, block, dca}.
   *   2. Variant expansion uses a curated small config list (≤ 4 per variant,
   *      ≤ 4 active variants) instead of the previous 4×4×4 = 64-entry
   *      Cartesian product. At max this generates ~16 entries per Base
   *      entry — ~4× faster than the old path and no silently-rejected
   *      entries (every config is pre-filtered to satisfy the DDT cap).
   *   3. Fingerprint cache — we record `{baseSetKey, base avgPF bucket,
   *      variant, posCtx bucket}` per generated Set. If the same fingerprint
   *      re-appears next cycle, we reuse the cached Set instead of
   *      regenerating ("IF NOT ALREADY CREATED").
   */
  private async createMainSets(
    symbol: string,
    inputSets?: StrategySet[],
    posCtx?: PositionContext,
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    // Prefer in-memory input (hot-path pipelined from createBaseSets). Fall
    // back to Redis only when called standalone (tests / diagnostics).
    let baseSets: StrategySet[]
    if (inputSets) {
      baseSets = inputSets
    } else {
      const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
      const stored = await getSettings(baseKey)
      baseSets = stored?.sets || []
    }

    const metrics = this.METRICS.main
    const maxEntries = this.config.maxEntriesPerSet || 250
    const ctx = posCtx ?? this.neutralPositionContext()
    const mainSets: StrategySet[] = []

    // ── 1. Fingerprint-cache lookup ────────────────────────────────────────
    // Fetch last cycle's fingerprint map up-front. `fpCacheKey` stores a
    // per-symbol hash of { fingerprint: JSON.stringify(set) } entries. We
    // read it once, check each candidate (baseSet × variant), and rebuild
    // only what's new. This cuts Main regeneration cost to ~0 when nothing
    // upstream has changed.
    const fpCacheKey = `strategies:${this.connectionId}:${symbol}:main:fp`
    const client = getRedisClient()
    const fpCache = ((await client.hgetall(fpCacheKey).catch(() => null)) || {}) as Record<string, string>
    const nextFpCache: Record<string, string> = {}
    let reused = 0

    // ── 2. Variant profiles ─────────────────────────────────────────────
    const activeVariants = this.selectActiveVariants(ctx)

    for (const baseSet of baseSets) {
      // Base-level validation — P0-2: PF + DDT are the ONLY filter axes.
      // Confidence is advisory metadata (used by Live stage's trailing-
      // variant selector) and is NOT a gate here. A high-PF / low-DDT
      // base Set with low confidence STILL promotes to Main for
      // downstream variant expansion.
      if (baseSet.avgProfitFactor < metrics.minProfitFactor) continue
      if (baseSet.avgDrawdownTime > metrics.maxDrawdownTime) continue

      for (const profile of activeVariants) {
        const fingerprint = this.variantFingerprint(baseSet, profile.name, ctx)

        // Cache hit — reuse the cached Set verbatim. This is the "IF NOT
        // ALREADY CREATED" path the user asked for.
        if (fpCache[fingerprint]) {
          try {
            const cached = JSON.parse(fpCache[fingerprint]) as StrategySet
            // Sanity-check the cached record before reusing it
            if (cached && Array.isArray(cached.entries) && cached.entries.length > 0) {
              mainSets.push(cached)
              nextFpCache[fingerprint] = fpCache[fingerprint]
              reused++
              continue
            }
          } catch { /* fall through — regenerate on parse failure */ }
        }

        // Cache miss — build a fresh related Set from this profile.
        // We thread `ctx` through so the freshly-built Set carries an
        // accurate `axisWindows` snapshot (prev/last/cont/pause) for
        // downstream stats dimensioning. Cached Sets keep the axis
        // window from the cycle they were materialised in (this is the
        // correct semantics — the gate that admitted them was based on
        // *that* ctx, and we don't want to retroactively re-bucket).
        const built = await this.buildVariantSet(baseSet, profile, metrics, maxEntries, ctx)
        if (!built) continue

        mainSets.push(built)
        // Store a compact serialisation in the fingerprint cache. Capped at
        // ~4KB per entry (the bulky `entries` array is already pruned to
        // maxEntries upstream; we stringify the whole Set for fidelity).
        nextFpCache[fingerprint] = JSON.stringify(built)
      }
    }

    // ─── VARIANT accounting ───────────────────────────────────────────────
    // Each related Main Set now carries an authoritative `variant` tag set
    // at build time, so we no longer have to heuristically classify
    // individual entries. Entries within a Set share the variant label.
    // Legacy entry-level classifier is kept as a fallback for any caller
    // that produces a Set without the variant field (back-compat safety).
    const classifyVariant = (e: StrategySetEntry): "default" | "trailing" | "block" | "dca" => {
      if (e.positionState === "reduce" || e.positionState === "close") return "dca"
      if (e.positionState === "add" || e.sizeMultiplier >= 1.5)        return "block"
      if (e.positionState === "new"  && e.leverage       >= 3)         return "trailing"
      return "default"
    }

    // Per-variant aggregates accumulated over all main sets in THIS cycle.
    // We write the per-variant totals with hincrby so they remain cumulative
    // across cycles (mirrors the per-stage hincrby pattern used elsewhere).
    type VariantAgg = {
      sumPF: number; sumDDT: number; entries: number; setsContaining: number; passedSets: number
    }
    const variantAgg: Record<string, VariantAgg> = {
      default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      pause:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
    }
    for (const set of mainSets) {
      const setVariant = set.variant ?? (set.entries[0] ? classifyVariant(set.entries[0]) : "default")
      variantAgg[setVariant].setsContaining += 1
      variantAgg[setVariant].passedSets     += 1
      for (const entry of set.entries) {
        variantAgg[setVariant].entries += 1
        variantAgg[setVariant].sumPF   += Number(entry.profitFactor || 0)
        variantAgg[setVariant].sumDDT  += Number(entry.drawdownTime || 0)
      }
    }

    // Persist MAIN sets + fingerprint cache. Fingerprint cache has a short
    // TTL so stale entries don't re-surface after context changes settle.
    const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
    await setSettings(mainKey, { sets: mainSets, count: mainSets.length, created: new Date() })
    try {
      if (Object.keys(nextFpCache).length > 0) {
        // Replace the cache atomically so deletions take effect (a Set that
        // no longer qualifies simply isn't re-written and falls out on TTL).
        await client.del(fpCacheKey).catch(() => {})
        await client.hset(fpCacheKey, nextFpCache)
        await client.expire(fpCacheKey, 300) // 5 min TTL
      }
    } catch { /* non-critical */ }

    // Write Main counts to progression hash — CUMULATIVE via hincrby so the dashboard
    // does not oscillate with per-cycle snapshots (see matching fix in createBaseSets).
    // Per-cycle snapshot is kept in `strategies_main_current` for components that want it.
    try {
      // Reuse the same client instance bound at the top of this function —
      // avoids an extra getRedisClient() call per cycle.
      const redisKey = `progression:${this.connectionId}`
      const mainDetailKey = `strategy_detail:${this.connectionId}:main`
      const mainAvgPF  = mainSets.length > 0 ? mainSets.reduce((s, st) => s + st.avgProfitFactor, 0) / mainSets.length : 0
      const mainAvgDDT = mainSets.length > 0 ? mainSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / mainSets.length : 0
      const passRatioMain = baseSets.length > 0 ? mainSets.length / baseSets.length : 0
      // Avg positions per Set at Main = avg of expanded entryCount values.
      // Each entry represents one (size × leverage × positionState) config
      // ready for downstream coordination, so this figure is the canonical
      // "how many positions does each validated Main Set hold?" metric.
      const mainEntriesTotal = mainSets.reduce((s, st) => s + (st.entryCount || 0), 0)
      const mainAvgPosPerSet = mainSets.length > 0 ? mainEntriesTotal / mainSets.length : 0

      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_main_current", String(mainSets.length)),
        client.expire(redisKey, 7 * 24 * 60 * 60),
        client.hset(mainDetailKey, {
          created_sets:      String(mainSets.length),
          avg_profit_factor: String(mainAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(mainAvgDDT)),
          avg_pos_per_set:   String(mainAvgPosPerSet.toFixed(2)),
          evaluated:         String(baseSets.length),
          passed_sets:       String(mainSets.length),
          pass_rate:         String(passRatioMain.toFixed(4)),
          entries_total:     String(mainEntriesTotal),
          updated_at:        String(Date.now()),
        }),
        client.expire(mainDetailKey, 86400),
        client.hset(`strategy_detail:${this.connectionId}:base`, {
          passed_sets: String(mainSets.length),
          pass_rate:   String(passRatioMain.toFixed(4)),
        }).catch(() => {}),
        client.set(`strategies:${this.connectionId}:main:count`, String(mainSets.length)),
        client.set(`strategies:${this.connectionId}:main:evaluated`, String(baseSets.length)),
        client.set(`strategies:${this.connectionId}:base:passed`, String(mainSets.length)),
        client.expire(`strategies:${this.connectionId}:main:count`, 86400),
        client.expire(`strategies:${this.connectionId}:main:evaluated`, 86400),
        client.expire(`strategies:${this.connectionId}:base:passed`, 86400),
      ]
      if (baseSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_main_total", baseSets.length))
      if (mainSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_main_evaluated", mainSets.length))

      // ── Main-stage COORDINATION metrics (per-cycle snapshot + cumulative) ─
      // These let the stats API answer the user's question "is the Main stage
      // coordinating correctly?" at a glance — how many related variant Sets
      // were generated vs. reused from the fingerprint cache, which variants
      // were gated active by the current position context, and the live
      // position-context snapshot (continuous / last-N wins / prev losses).
      const relatedCreated = mainSets.length - reused
      const activeVariantNames = activeVariants.map((p) => p.name)

      writes.push(
        // Cumulative counters (lifetime)
        client.hincrby(redisKey, "strategies_main_related_created", relatedCreated),
        client.hincrby(redisKey, "strategies_main_related_reused",  reused),
        client.hincrby(redisKey, "strategies_main_cycles",          1),
        // Per-cycle snapshot fields (overwrite every cycle — "what happened now")
        client.hset(redisKey, {
          strategies_main_active_variants:   activeVariantNames.join(","),
          strategies_main_active_variant_count: String(activeVariantNames.length),
          strategies_main_last_reused:       String(reused),
          strategies_main_last_created:      String(relatedCreated),
          strategies_main_ctx_continuous:    String(ctx.continuousCount),
          strategies_main_ctx_last_wins:     String(ctx.lastWins),
          strategies_main_ctx_last_losses:   String(ctx.lastLosses),
          strategies_main_ctx_prev_losses:   String(ctx.prevLosses),
          strategies_main_ctx_prev_total:    String(ctx.prevPosCount),
          strategies_main_ctx_updated_at:    String(Date.now()),
        }),
      )

      // ── Per-axis Position-Count window counters (cumulative) ──────────
      //
      // Spec: *"step 1 previous 1-12; Last (of previous) 1-4; continuous
      // 1-8 and Pause 1-8"*. Every Main Set materialised this cycle was
      // gated on a position context whose four axes fall into one of
      // these step-1 buckets. We hincrby a per-axis-N counter so the
      // dashboard can show "how many Main Sets were created under each
      // axis window" without re-deriving from raw events.
      //
      // Axis windows are encoded on each Set via `axisWindows` — see
      // `buildVariantSet`. A Set with `axisWindows.prev = 5` increments
      // `strategies_main_axis_prev_5_sets` (and similarly for last/cont/
      // pause). 0 buckets are still emitted (the operator may want to
      // see how often a given axis was inactive). Block + DCA Sets share
      // the same axis snapshot as the cycle's ctx, so they roll up to
      // the same per-axis tile cleanly without special-casing.
      //
      // Storage cost is bounded: at most (12+5+9+9) = 35 sub-keys per
      // axis lifetime, all on the same `axis_windows:{id}` hash so a
      // single hgetall covers the whole panel. Counter writes are
      // pipelined with the rest of the Main writes for free.
      const axisHashKey = `axis_windows:${this.connectionId}`
      const axisIncrements: Record<string, number> = {}
      for (const set of mainSets) {
        const aw = set.axisWindows
        if (!aw) continue
        // Per-axis-N bucket (count of *Sets* that landed under each window)
        axisIncrements[`prev_${aw.prev}_sets`]  = (axisIncrements[`prev_${aw.prev}_sets`]  || 0) + 1
        axisIncrements[`last_${aw.last}_sets`]  = (axisIncrements[`last_${aw.last}_sets`]  || 0) + 1
        axisIncrements[`cont_${aw.cont}_sets`]  = (axisIncrements[`cont_${aw.cont}_sets`]  || 0) + 1
        axisIncrements[`pause_${aw.pause}_sets`] = (axisIncrements[`pause_${aw.pause}_sets`] || 0) + 1
        // Per-axis-N entries — entries are the "Pos counts" the dashboard
        // labels as "positions" inside each axis window (one per (size ×
        // leverage × state) config the variant projected through).
        const ec = set.entryCount || 0
        if (ec > 0) {
          axisIncrements[`prev_${aw.prev}_pos`]   = (axisIncrements[`prev_${aw.prev}_pos`]   || 0) + ec
          axisIncrements[`last_${aw.last}_pos`]   = (axisIncrements[`last_${aw.last}_pos`]   || 0) + ec
          axisIncrements[`cont_${aw.cont}_pos`]   = (axisIncrements[`cont_${aw.cont}_pos`]   || 0) + ec
          axisIncrements[`pause_${aw.pause}_pos`] = (axisIncrements[`pause_${aw.pause}_pos`] || 0) + ec
        }
      }
      for (const [field, n] of Object.entries(axisIncrements)) {
        if (n > 0) writes.push(client.hincrby(axisHashKey, field, n))
      }
      writes.push(client.hset(axisHashKey, { updated_at: String(Date.now()) }))
      writes.push(client.expire(axisHashKey, 7 * 24 * 60 * 60))

      // ── Variant persistence (cumulative over the lifetime of the run) ──
      // For each variant we accumulate:
      //   entries_count   — total entries classified under this variant (incr)
      //   created_sets    — total Sets containing ≥1 entry of variant (incr)
      //   passed_sets     — same as created_sets at Main stage (all passed)
      //   sum_pf          — running sum of profitFactor for weighted avg
      //   sum_ddt         — running sum of drawdownTime for weighted avg
      //   avg_profit_factor / avg_drawdown_time / avg_pos_per_set — derived
      //
      // Using hincrby for the counters keeps them append-only and crash-safe.
      // The derived averages are rewritten as hset after each accumulation so
      // the stats API can read them directly without recomputing on the fly.
      for (const variant of ["default", "trailing", "block", "dca", "pause"] as const) {
        const agg = variantAgg[variant]
        if (agg.entries === 0) continue

        const vKey = `strategy_variant:${this.connectionId}:${variant}`
        writes.push(
          client.hincrby(vKey, "entries_count",  agg.entries),
          client.hincrby(vKey, "created_sets",   agg.setsContaining),
          client.hincrby(vKey, "passed_sets",    agg.passedSets),
          // Scaled integer sums (×1000 for PF, ×10 for DDT minutes) so we can
          // use hincrby atomically. We reconstruct the floats on read.
          client.hincrby(vKey, "sum_pf_x1000",   Math.round(agg.sumPF * 1000)),
          client.hincrby(vKey, "sum_ddt_x10",    Math.round(agg.sumDDT * 10)),
          client.hset(vKey, { updated_at: new Date().toISOString() }),
          client.expire(vKey, 7 * 24 * 60 * 60),
        )
      }
      await Promise.all(writes)

      // After the atomic counter writes finalise, rewrite the derived averages
      // in a follow-up pass (one more round-trip per variant worst-case). Read
      // the freshly-incremented counters so the averages always reflect the
      // full lifetime of the run rather than just the current cycle.
      try {
        const recompute: Promise<any>[] = []
        for (const variant of ["default", "trailing", "block", "dca", "pause"] as const) {
          const agg = variantAgg[variant]
          if (agg.entries === 0) continue
          const vKey = `strategy_variant:${this.connectionId}:${variant}`
          recompute.push(
            (async () => {
              const h = ((await client.hgetall(vKey).catch(() => null)) || {}) as Record<string, string>
              const entriesCount = Number(h.entries_count  || "0")
              const createdSets  = Number(h.created_sets   || "0")
              const sumPfX1000   = Number(h.sum_pf_x1000   || "0")
              const sumDdtX10    = Number(h.sum_ddt_x10    || "0")
              const avgPF  = entriesCount > 0 ? (sumPfX1000  / 1000) / entriesCount : 0
              const avgDDT = entriesCount > 0 ? (sumDdtX10   / 10)   / entriesCount : 0
              const avgPosPerSet = createdSets > 0 ? entriesCount / createdSets : 0
              const passRate = createdSets > 0 ? (Number(h.passed_sets || "0") / createdSets) : 0
              await client.hset(vKey, {
                avg_profit_factor: avgPF.toFixed(4),
                avg_drawdown_time: avgDDT.toFixed(2),
                avg_pos_per_set:   avgPosPerSet.toFixed(2),
                pass_rate:         passRate.toFixed(4),
              })
            })(),
          )
        }
        await Promise.all(recompute)
      } catch { /* non-critical */ }
    } catch { /* non-critical */ }

    // `failedEvaluation` counts Base Sets that were rejected by the validation
    // filter. When a single Base Set produces multiple related variant Sets
    // (default + trailing + block …) we still want the pass/fail accounting
    // to reference the unique Base Sets, so derive it from parent lineage.
    const uniqueBaseSetsProduced = new Set<string>()
    for (const s of mainSets) uniqueBaseSetsProduced.add(s.parentSetKey ?? s.setKey)
    const failed = baseSets.length - uniqueBaseSetsProduced.size

    if (baseSets.length > 0) {
      const sample = baseSets[0]
      const variantBreakdown = ["default", "trailing", "block", "dca", "pause"]
        .map((v) => `${v[0]}=${mainSets.filter((s) => s.variant === v).length}`)
        .join(",")
      console.log(
        `[v0] [StrategyFlow] ${symbol} MAIN: ${mainSets.length} sets (${uniqueBaseSetsProduced.size}/${baseSets.length} bases, reused=${reused}) ` +
        `variants={${variantBreakdown}} ctx={cont=${ctx.continuousCount},lastW=${ctx.lastWins},lastL=${ctx.lastLosses},prevL=${ctx.prevLosses}} ` +
        `| sample={pf=${sample.avgProfitFactor.toFixed(2)}, conf=${sample.avgConfidence.toFixed(2)}}`
      )
    } else {
      console.log(`[v0] [StrategyFlow] ${symbol} MAIN: 0 base sets available`)
    }

    return {
      result: {
        type: "main",
        symbol,
        timestamp: new Date(),
        totalCreated: baseSets.length,
        passedEvaluation: mainSets.length,
        failedEvaluation: failed,
        avgProfitFactor: mainSets.length > 0 ? mainSets.reduce((s, set) => s + set.avgProfitFactor, 0) / mainSets.length : 0,
        avgDrawdownTime: mainSets.length > 0 ? mainSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / mainSets.length : 0,
      },
      sets: mainSets,
    }
  }

  // ─── STAGE 3: REAL ───────────────────────────────────────────────────────────

  /**
   * Promote MAIN Sets with avgProfitFactor >= 1.4 to REAL.
   */
  private async evaluateRealSets(
    symbol: string,
    inputSets?: StrategySet[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    let stored: any = null
    if (!inputSets) {
      const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
      stored = await getSettings(mainKey)
    }
    const mainSets: StrategySet[] = inputSets ?? (stored?.sets || [])

    const metrics = this.METRICS.real

    // P0-2: Real filter axes are PF-min + DDT-max ONLY. Confidence is
    // advisory metadata and is not part of the filter predicate.
    const realSets = mainSets.filter(
      (s) =>
        s.avgProfitFactor >= metrics.minProfitFactor &&
        s.avgDrawdownTime <= metrics.maxDrawdownTime,
    )

    // Debug: show why sets failed REAL filter
    if (mainSets.length > 0 && realSets.length === 0) {
      const sample = mainSets[0]
      console.log(`[v0] [StrategyFlow] ${symbol} REAL filter rejected all: sample={pf=${sample.avgProfitFactor.toFixed(2)}, ddt=${sample.avgDrawdownTime.toFixed(0)}, conf=${sample.avgConfidence.toFixed(2)} (advisory)} threshold={minPF=${metrics.minProfitFactor}, maxDDT=${metrics.maxDrawdownTime}}`)
    }

    // Persist REAL sets
    const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
    await setSettings(realKey, { sets: realSets, count: realSets.length, created: new Date() })

    // Write Real counts to progression hash — CUMULATIVE via hincrby so the dashboard
    // doesn't oscillate with per-cycle snapshots (see matching fix in createBaseSets/createMainSets).
    // Per-cycle snapshot is kept in `strategies_real_current` for components that want it.
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const realDetailKey = `strategy_detail:${this.connectionId}:real`
      const realAvgPF   = realSets.length > 0 ? realSets.reduce((s, st) => s + st.avgProfitFactor, 0) / realSets.length : 0
      const realAvgDDT  = realSets.length > 0 ? realSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / realSets.length : 0
      const realAvgConf = realSets.length > 0 ? realSets.reduce((s, st) => s + (st.avgConfidence || 0), 0) / realSets.length : 0
      const passRatioReal = mainSets.length > 0 ? realSets.length / mainSets.length : 0
      const realEntriesTotal  = realSets.reduce((s, st) => s + (st.entryCount || 0), 0)
      const realAvgPosPerSet  = realSets.length > 0 ? realEntriesTotal / realSets.length : 0

      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_real_current", String(realSets.length)),
        client.expire(redisKey, 7 * 24 * 60 * 60),
        client.hset(realDetailKey, {
          created_sets:       String(realSets.length),
          avg_profit_factor:  String(realAvgPF.toFixed(4)),
          avg_drawdown_time:  String(Math.round(realAvgDDT)),
          avg_pos_eval_real:  String(realAvgConf.toFixed(4)),
          avg_pos_per_set:    String(realAvgPosPerSet.toFixed(2)),
          evaluated:          String(mainSets.length),
          passed_sets:        String(realSets.length),
          pass_rate:          String(passRatioReal.toFixed(4)),
          count_pos_eval:     String(realSets.length),
          entries_total:      String(realEntriesTotal),
          updated_at:         String(Date.now()),
        }),
        client.expire(realDetailKey, 86400),
        client.hset(`strategy_detail:${this.connectionId}:main`, {
          passed_sets: String(realSets.length),
          pass_rate:   String(passRatioReal.toFixed(4)),
        }).catch(() => {}),
        client.set(`strategies:${this.connectionId}:real:count`, String(realSets.length)),
        client.set(`strategies:${this.connectionId}:real:evaluated`, String(mainSets.length)),
        client.set(`strategies:${this.connectionId}:main:passed`, String(realSets.length)),
        client.expire(`strategies:${this.connectionId}:real:count`, 86400),
        client.expire(`strategies:${this.connectionId}:real:evaluated`, 86400),
        client.expire(`strategies:${this.connectionId}:main:passed`, 86400),
      ]
      if (mainSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_real_total", mainSets.length))
      if (realSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_real_evaluated", realSets.length))

      // ── P1-1: Real-stage per-variant aggregation ────────────────────
      // Same shape as Main's `variantAgg` but computed over the Real
      // output (post-PF/DDT filter). Lets the stats API answer "how
      // much of Real is Default vs Adjust{Block, DCA} vs Trailing?"
      // without re-scanning every set on read.
      type RealVariantAgg = {
        sumPF: number; sumDDT: number; entries: number; setsContaining: number; passedSets: number
      }
      const realVariantAgg: Record<string, RealVariantAgg> = {
        default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        pause:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      }
      for (const set of realSets) {
        const setVariant = (set.variant as keyof typeof realVariantAgg) ?? "default"
        realVariantAgg[setVariant].setsContaining += 1
        realVariantAgg[setVariant].passedSets     += 1
        for (const entry of set.entries) {
          realVariantAgg[setVariant].entries += 1
          realVariantAgg[setVariant].sumPF   += Number(entry.profitFactor || 0)
          realVariantAgg[setVariant].sumDDT  += Number(entry.drawdownTime || 0)
        }
      }
      for (const variant of ["default", "trailing", "block", "dca", "pause"] as const) {
        const agg = realVariantAgg[variant]
        if (agg.entries === 0) continue
        const vKey = `strategy_variant_real:${this.connectionId}:${variant}`
        writes.push(
          client.hincrby(vKey, "entries_count",  agg.entries),
          client.hincrby(vKey, "created_sets",   agg.setsContaining),
          client.hincrby(vKey, "passed_sets",    agg.passedSets),
          client.hincrby(vKey, "sum_pf_x1000",   Math.round(agg.sumPF * 1000)),
          client.hincrby(vKey, "sum_ddt_x10",    Math.round(agg.sumDDT * 10)),
          client.hset(vKey, { updated_at: new Date().toISOString() }),
          client.expire(vKey, 7 * 24 * 60 * 60),
        )
      }
      await Promise.all(writes)

      // Second pass — derive averages from freshly-incremented counters
      // so the stats API can read them without recomputing.
      try {
        const recompute: Promise<any>[] = []
        for (const variant of ["default", "trailing", "block", "dca", "pause"] as const) {
          if (realVariantAgg[variant].entries === 0) continue
          const vKey = `strategy_variant_real:${this.connectionId}:${variant}`
          recompute.push(
            (async () => {
              const h = ((await client.hgetall(vKey).catch(() => null)) || {}) as Record<string, string>
              const entriesCount = Number(h.entries_count  || "0")
              const createdSets  = Number(h.created_sets   || "0")
              const sumPfX1000   = Number(h.sum_pf_x1000   || "0")
              const sumDdtX10    = Number(h.sum_ddt_x10    || "0")
              const avgPF  = entriesCount > 0 ? (sumPfX1000  / 1000) / entriesCount : 0
              const avgDDT = entriesCount > 0 ? (sumDdtX10   / 10)   / entriesCount : 0
              const avgPosPerSet = createdSets > 0 ? entriesCount / createdSets : 0
              const passRate = createdSets > 0 ? (Number(h.passed_sets || "0") / createdSets) : 0
              await client.hset(vKey, {
                avg_profit_factor: avgPF.toFixed(4),
                avg_drawdown_time: avgDDT.toFixed(2),
                avg_pos_per_set:   avgPosPerSet.toFixed(2),
                pass_rate:         passRate.toFixed(4),
              })
            })(),
          )
        }
        await Promise.all(recompute)
      } catch { /* non-critical */ }
    } catch { /* non-critical */ }

    console.log(
      `[v0] [StrategyFlow] ${symbol} REAL: ${realSets.length}/${mainSets.length} Sets promoted (minPF=${metrics.minProfitFactor}, maxDDT=${metrics.maxDrawdownTime})`
    )

    return {
      result: {
        type: "real",
        symbol,
        timestamp: new Date(),
        totalCreated: mainSets.length,
        passedEvaluation: realSets.length,
        failedEvaluation: mainSets.length - realSets.length,
        avgProfitFactor: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgProfitFactor, 0) / realSets.length : 0,
        avgDrawdownTime: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / realSets.length : 0,
      },
      sets: realSets,
    }
  }

  // ─── STAGE 4: LIVE ─────────��──────────��──────��──────────────────────���────────

  /**
   * Select the best 500 Sets from REAL for live trading.
   * Creates exactly ONE pseudo position per Set (per indication_type × direction).
   */
  private async createLiveSets(
    symbol: string,
    inputSets?: StrategySet[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    let realSets: StrategySet[]
    if (inputSets) {
      realSets = inputSets
    } else {
      const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
      const stored = await getSettings(realKey)
      realSets = stored?.sets || []
    }

    const metrics = this.METRICS.live
    const maxLive = this.config.maxLiveSets || 500

    // P0-2: Live filter axes are PF-min + DDT-max ONLY (then rank by
    // avgProfitFactor and take top N). Confidence is advisory metadata.
    const qualifying = realSets
      .filter(
        (s) =>
          s.avgProfitFactor >= metrics.minProfitFactor &&
          s.avgDrawdownTime <= metrics.maxDrawdownTime,
      )
      .sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
      .slice(0, maxLive)

    console.log(`[v0] [StrategyFlow] ${symbol} LIVE: ${qualifying.length}/${realSets.length} Sets selected (top ${maxLive} by PF, minPF=${metrics.minProfitFactor}, maxDDT=${metrics.maxDrawdownTime})`)
    if (realSets.length > 0 && qualifying.length === 0) {
      const sample = realSets[0]
      console.log(`[v0] [StrategyFlow] ${symbol} LIVE filter rejected all real sets: sample={pf=${sample.avgProfitFactor.toFixed(2)}, ddt=${sample.avgDrawdownTime.toFixed(0)}, conf=${sample.avgConfidence.toFixed(2)} (advisory)}`)
    }

    // Persist LIVE sets
    const liveKey = `strategies:${this.connectionId}:${symbol}:live:sets`
    await setSettings(liveKey, {
      sets: qualifying,
      count: qualifying.length,
      created: new Date(),
      executable: true,
    })

    // Write live set count into progression hash — use hset so count reflects current cycle snapshot.
    // NOTE: strategies_real_total and strategy_evaluated_real are already written by evaluateRealSets.
    // Previously this block fired 7 sequential Redis round-trips (hset × 2, set, expire × 3, + a
    // compound hset). Parallelising them cuts the per-cycle Redis stall to a single network hop
    // worth of latency, matching the base/main/real coordinators.
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const liveDetailKey = `strategy_detail:${this.connectionId}:live`
      const liveCountKey = `strategies:${this.connectionId}:live:count`

      const liveAvgPF  = qualifying.length > 0 ? qualifying.reduce((s, st) => s + st.avgProfitFactor, 0) / qualifying.length : 0
      const liveAvgDDT = qualifying.length > 0 ? qualifying.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / qualifying.length : 0
      const passRatioLive = realSets.length > 0 ? qualifying.length / realSets.length : 0

      // ── P1-1: Live-stage per-variant aggregation ──────────────────────
      // Same bucket shape as Main/Real. Drives the stats API's breakdown
      // of which variant family (Default / Trailing / Block / DCA) is
      // contributing Sets to the live mirror. Kept as a single Promise.all
      // so we still land in one network hop.
      type LiveVariantAgg = {
        sumPF: number; sumDDT: number; entries: number; setsContaining: number
      }
      const liveVariantAgg: Record<string, LiveVariantAgg> = {
        default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        pause:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
      }
      for (const set of qualifying) {
        const variant = (set.variant as keyof typeof liveVariantAgg) ?? "default"
        liveVariantAgg[variant].setsContaining += 1
        for (const entry of set.entries) {
          liveVariantAgg[variant].entries += 1
          liveVariantAgg[variant].sumPF   += Number(entry.profitFactor || 0)
          liveVariantAgg[variant].sumDDT  += Number(entry.drawdownTime || 0)
        }
      }

      const liveVariantWrites: Promise<any>[] = []
      for (const variant of ["default", "trailing", "block", "dca", "pause"] as const) {
        const agg = liveVariantAgg[variant]
        if (agg.entries === 0) continue
        const vKey = `strategy_variant_live:${this.connectionId}:${variant}`
        const avgPF  = agg.sumPF  / agg.entries
        const avgDDT = agg.sumDDT / agg.entries
        liveVariantWrites.push(
          client.hset(vKey, {
            created_sets:      String(agg.setsContaining),
            entries_count:     String(agg.entries),
            avg_profit_factor: avgPF.toFixed(4),
            avg_drawdown_time: avgDDT.toFixed(2),
            avg_pos_per_set:   (agg.entries / agg.setsContaining).toFixed(2),
            updated_at:        String(Date.now()),
          }),
          client.expire(vKey, 7 * 24 * 60 * 60),
        )
      }

      await Promise.all([
        client.hset(redisKey, "strategies_live_total", String(qualifying.length)),
        client.expire(redisKey, 7 * 24 * 60 * 60),
        client.hset(liveDetailKey, {
          created_sets:      String(qualifying.length),
          avg_profit_factor: String(liveAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(liveAvgDDT)),
          evaluated:         String(realSets.length),
          passed_sets:       String(qualifying.length),
          pass_rate:         String(passRatioLive.toFixed(4)),
          updated_at:        String(Date.now()),
        }),
        client.expire(liveDetailKey, 86400),
        // `set` with EX in a single command avoids the separate expire round-trip.
        client.set(liveCountKey, String(qualifying.length), { EX: 86400 } as any),
        ...liveVariantWrites,
      ])
    } catch { /* non-critical */ }

    // Attempt real exchange trading for qualifying LIVE sets when the connection has live trading enabled.
    // This is guarded by is_live_trade flag on the connection — if disabled, only pseudo positions are created.
    if (qualifying.length > 0) {
      try {
        // Use getConnection() as authoritative source — it reads connection:{id} hash via parseHash
        // which handles boolean/string coercion. Raw hgetall may miss "true" vs "1" vs boolean true.
        const { getConnection: getConn } = await import("@/lib/redis-db")
        const connData = await getConn(this.connectionId)
        const { isTruthyFlag } = await import("@/lib/connection-state-utils")
        const isLiveTrade = isTruthyFlag(connData?.is_live_trade) || isTruthyFlag(connData?.live_trade_enabled)
        console.log(`[v0] [StrategyFlow] ${symbol} LIVE gate: is_live_trade=${isLiveTrade} (raw=${JSON.stringify(connData?.is_live_trade)}, conn=${this.connectionId})`)
        if (isLiveTrade) {
          const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
          const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
          const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
          if (connector) {
            // Dispatch each qualifying set as a live exchange position. The
            // full pipeline (pre-flight → price fetch → volume calc → leverage
            // setup → entry order → fill poll → SL/TP → exchange sync → logs
            // → metrics) is owned by executeLivePosition. We only supply the
            // strategic inputs (direction, SL/TP %, leverage hint) and let the
            // pipeline decide the exact quantity and entry price from live
            // exchange state.
            let placed = 0
            let filled = 0
            let rejected = 0
            let errored = 0

            for (const set of qualifying) {
              try {
                const bestEntry = set.entries.reduce(
                  (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                  set.entries[0]
                )
                if (!bestEntry) continue

                // Derive SL/TP % from the set's profit factor. The pipeline
                // converts these to concrete prices after the entry fills.
                const tp = Math.max(0.5, (bestEntry.profitFactor - 1) * 100)
                const sl = Math.min(5, (100 / Math.max(1, bestEntry.profitFactor)) * 0.5)

                const liveResult = await executeLivePosition(
                  this.connectionId,
                  {
                    id: `real:${this.connectionId}:${set.setKey}:${symbol}:${Date.now()}`,
                    connectionId: this.connectionId,
                    symbol,
                    direction: set.direction,
                    // Seed values — the live pipeline will recalc both from
                    // the exchange connector and VolumeCalculator.
                    quantity: 0,
                    entryPrice: 0,
                    leverage: bestEntry.leverage || 1,
                    riskAmount: 0,
                    rewardTarget: 0,
                    stopLoss: sl,
                    takeProfit: tp,
                    mainPositionCount: set.entryCount,
                    evaluationScore: bestEntry.confidence,
                    ratioMet: bestEntry.confidence >= 0.65,
                    timestamp: Date.now(),
                    ratios: {
                      profitabilityRatio: bestEntry.profitFactor,
                      accountRiskRatio: sl / 100,
                      successRateRatio: bestEntry.confidence,
                      consistencyRatio: set.avgConfidence,
                    },
                    status: "pending",
                  },
                  connector
                )

                if (!liveResult) continue
                if (liveResult.status === "open" || liveResult.status === "filled" || liveResult.status === "partially_filled") {
                  filled++
                  placed++
                } else if (liveResult.status === "placed") {
                  placed++
                } else if (liveResult.status === "rejected") {
                  rejected++
                } else if (liveResult.status === "error") {
                  errored++
                }
              } catch (err) {
                errored++
                console.warn(
                  `[v0] [StrategyFlow] ${symbol} per-set live execution error:`,
                  err instanceof Error ? err.message : String(err)
                )
              }
            }

            if (placed > 0 || rejected > 0 || errored > 0) {
              console.log(
                `[v0] [StrategyFlow] ${symbol} LIVE summary — placed=${placed} filled=${filled} rejected=${rejected} errored=${errored}`
              )
            }
          } else {
            console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: live_trade=true but connector not available`)
          }
        }
      } catch (liveErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Real exchange execution error:`, liveErr instanceof Error ? liveErr.message : String(liveErr))
      }

      // After dispatching new entries, reconcile already-open positions with
      // the exchange so that any SL/TP/manual-close that happened since the
      // last cycle transitions the Redis record to "closed". Rate-limited per
      // connection to once every 30 seconds to stay well within exchange
      // rate limits while still providing near-real-time closure tracking.
      try {
        const client = getRedisClient()
        const rlKey = `live:reconcile:ratelimit:${this.connectionId}`
        const last = await client.get(rlKey).catch(() => null)
        const now = Date.now()
        const lastTs = last ? parseInt(last as string, 10) : 0
        if (!lastTs || now - lastTs > 30_000) {
          await client.setex(rlKey, 60, String(now)).catch(() => {})
          // Fire-and-forget: don't block the strategy flow on exchange IO.
          ;(async () => {
            try {
              const { reconcileLivePositions } = await import("@/lib/trade-engine/stages/live-stage")
              const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
              const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
              if (connector) {
                const result = await reconcileLivePositions(this.connectionId, connector)
                if (result.closed > 0) {
                  console.log(
                    `[v0] [StrategyFlow] ${this.connectionId} reconcile closed ${result.closed} positions via exchange sync`
                  )
                }
              }
            } catch (reconErr) {
              console.warn(
                `[v0] [StrategyFlow] ${this.connectionId} reconcile error:`,
                reconErr instanceof Error ? reconErr.message : String(reconErr)
              )
            }
          })()
        }
      } catch {
        /* non-critical; skip if redis rate-limit read fails */
      }
    }

    // Create EXACTLY ONE pseudo position per Set (one per indication_type × direction combination).
    // Each Set represents a unique (indication_type × direction) coordinate.
    // We pick the highest-profitFactor entry from the Set as the representative config for the position.
    if (qualifying.length > 0) {
      try {
        const posManager = new PseudoPositionManager(this.connectionId)

        // Fetch current market price for entry
        let entryPrice = 0
        try {
          const client = getRedisClient()
          const mdhash = await client.hgetall(`market_data:${symbol}`)
          entryPrice = parseFloat(mdhash?.close || mdhash?.price || "0")
          if (!entryPrice || isNaN(entryPrice)) {
            const mdraw = await client.get(`market_data:${symbol}:1m`)
            if (mdraw) {
              const mdobj = JSON.parse(mdraw)
              const candles = mdobj?.candles
              if (Array.isArray(candles) && candles.length > 0) {
                entryPrice = parseFloat(candles[candles.length - 1]?.close || "0")
              }
            }
          }
        } catch { /* skip price lookup */ }

        if (entryPrice > 0) {
          // Pseudo-position creation is local Redis work with per-Set idempotency
          // enforced inside createPosition (one active pseudo position per Set).
          // Safe to fan out in parallel — no exchange calls, no shared balance.
          const creations = await Promise.all(
            qualifying.map(async (set) => {
              try {
                const bestEntry = set.entries.reduce(
                  (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                  set.entries[0],
                )
                if (!bestEntry) return false

                const tp = Math.max(0.5, (bestEntry.profitFactor - 1) * 100)
                const sl = Math.min(5, 100 / Math.max(1, bestEntry.profitFactor) * 0.5)
                const trailing = bestEntry.confidence >= 0.85
                const configSetKey = `${set.indicationType}:${set.direction}:${symbol}`

                const posId = await posManager.createPosition({
                  symbol,
                  side: set.direction,
                  indicationType: set.indicationType,
                  entryPrice,
                  takeprofitFactor: tp,
                  stoplossRatio: sl,
                  profitFactor: bestEntry.profitFactor,
                  trailingEnabled: trailing,
                  configSetKey,
                })
                return Boolean(posId)
              } catch {
                return false
              }
            }),
          )
          const positionsCreated = creations.filter(Boolean).length
          console.log(`[v0] [StrategyFlow] ${symbol} LIVE: Created/updated ${positionsCreated} pseudo positions for ${qualifying.length} Sets`)
        } else {
          console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: No entry price, skipping position creation`)
        }
      } catch (posErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Position creation error:`, posErr instanceof Error ? posErr.message : String(posErr))
      }
    }

    console.log(
      `[v0] [StrategyFlow] ${symbol} LIVE: ${qualifying.length}/${realSets.length} Sets selected (top ${maxLive} by PF, minPF=${metrics.minProfitFactor})`
    )

    return {
      result: {
        type: "live",
        symbol,
        timestamp: new Date(),
        totalCreated: realSets.length,
        passedEvaluation: qualifying.length,
        failedEvaluation: realSets.length - qualifying.length,
        avgProfitFactor: qualifying.length > 0 ? qualifying.reduce((s, set) => s + set.avgProfitFactor, 0) / qualifying.length : 0,
        avgDrawdownTime: qualifying.length > 0 ? qualifying.reduce((s, set) => s + set.avgDrawdownTime, 0) / qualifying.length : 0,
      },
      sets: qualifying,
    }
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────

  // Per-cycle position-context cache. The pseudo-position list is shared
  // across all Main invocations within the same cycle to amortise Redis
  // reads when many symbols go through the flow in rapid succession.
  private positionContextCache: { ctx: PositionContext; ts: number } | null = null
  private readonly POSITION_CONTEXT_TTL_MS = 2000

  /**
   * Produce a neutral position context — no open positions, no prior wins
   * or losses. Used for prehistoric/backtest runs and as a fallback when the
   * pseudo-position read fails (keeps Main operational even if the position
   * index is temporarily unavailable).
   */
  private neutralPositionContext(): PositionContext {
    return {
      continuousCount: 0,
      lastPosCount: 0,
      prevPosCount: 0,
      lastWins: 0,
      lastLosses: 0,
      prevLosses: 0,
      perSymbolOpen: {},
    }
  }

  /**
   * Fetch the per-cycle position coordination context used by MAIN to decide
   * which additional related variant Sets to produce. Reads pseudo positions
   * once and buckets them into continuous (active) vs last-N closed vs full
   * lookback window. Results are cached for POSITION_CONTEXT_TTL_MS so
   * symbols processed in rapid succession share a single Redis read.
   */
  private async getPositionContext(): Promise<PositionContext> {
    const now = Date.now()
    if (this.positionContextCache && now - this.positionContextCache.ts < this.POSITION_CONTEXT_TTL_MS) {
      return this.positionContextCache.ctx
    }

    try {
      const posManager = new PseudoPositionManager(this.connectionId)
      const active = await posManager.getActivePositions()

      // Build per-symbol open-position map from the active list (continuous
      // positions). No extra Redis reads — getActivePositions already pulls
      // the full hashes behind a 1s internal cache.
      const perSymbolOpen: Record<string, number> = {}
      for (const p of active) {
        const sym = String(p.symbol || "")
        if (!sym) continue
        perSymbolOpen[sym] = (perSymbolOpen[sym] ?? 0) + 1
      }

      // For closed-window stats we read the pseudo-position index directly
      // and only fetch hashes for positions NOT in the active set. This
      // keeps the hot path O(active + window) rather than O(all history).
      // A 24h lookback + max 50 recent closed positions is a good trade-off
      // between signal quality and Redis load.
      const client = getRedisClient()
      const setKey = `pseudo_positions:${this.connectionId}`
      const lookbackMs = 24 * 60 * 60 * 1000
      const cutoff = now - lookbackMs
      const WINDOW_CAP = 50

      let prevPosCount = 0
      let prevLosses = 0
      const lastN: Array<{ closedAt: number; pnl: number }> = []
      try {
        const allIds: string[] = (await client.smembers(setKey).catch(() => [])) || []
        // Exclude active ids up-front so we don't double-read their hashes
        const activeIdSet = new Set(active.map((p: any) => String(p.id || "")))
        const closedIds = allIds.filter((id: string) => !activeIdSet.has(String(id)))

        // Fetch hashes in parallel — bounded to WINDOW_CAP * 2 to stay cheap
        // when the connection has a huge historical archive.
        const sampledIds = closedIds.slice(-WINDOW_CAP * 2)
        const hashes = await Promise.all(
          sampledIds.map(async (id) => {
            try {
              const h = await client.hgetall(`pseudo_position:${this.connectionId}:${id}`)
              return h && Object.keys(h).length > 0 ? h : null
            } catch {
              return null
            }
          }),
        )

        for (const h of hashes) {
          if (!h) continue
          // ── P2-1: Strict closed-only gate ──────────────────────────────
          // Main variant gating (prevLosses, lastWins, lastLosses,
          // prevPosCount, lastPosCount) MUST be computed from closed
          // pseudo positions ONLY. Previously this block used the
          // `opened_at` value as a fallback for the close timestamp and
          // read `h.pnl` blindly — both of which made floating open
          // positions (their mark-to-market PnL) leak into the stats
          // that drive fingerprint buckets and `selectActiveVariants`
          // gates. Now we enforce three explicit conditions:
          //   (1) `status === "closed"` — hard gate. Any other value
          //       (open, pending, rejected, error, partial) is ignored.
          //   (2) a valid numeric `closed_at` / `closedAt` within the
          //       lookback window. `opened_at` is NO LONGER a fallback.
          //   (3) a realized-pnl field (`realized_pnl` or `pnl` written
          //       AT close) — not the live unrealised value.
          const status = String(h.status || "").toLowerCase()
          if (status !== "closed") continue
          const closedAtRaw = h.closed_at ?? h.closedAt ?? 0
          const closedAt = Number(closedAtRaw)
          if (!Number.isFinite(closedAt) || closedAt <= 0) continue
          if (closedAt < cutoff) continue
          // Prefer `realized_pnl`; fall back to `pnl` only when the row
          // is marked closed (the closePosition pipeline writes `pnl`
          // to the realized value at close time).
          const pnlRaw = h.realized_pnl ?? h.pnl ?? h.profit ?? 0
          const pnl = Number(pnlRaw)
          if (!Number.isFinite(pnl)) continue
          prevPosCount++
          if (pnl < 0) prevLosses++
          lastN.push({ closedAt, pnl })
        }
        // Keep the 8 most recently closed for the "last-N" breakdown.
        // Spec: Pause variant validates against the last 1-8 positions
        // (step 1) — each lookback window N feeds one Pause sub-config.
        // The remaining gates (`trailing.lastWins >= 2`, etc.) only ever
        // need the top of this list, so the wider window is essentially
        // free for them.
        lastN.sort((a, b) => b.closedAt - a.closedAt)
        lastN.length = Math.min(lastN.length, 8)
      } catch { /* best-effort; fall through with zeros */ }

      const ctx: PositionContext = {
        continuousCount: active.length,
        lastPosCount:    lastN.length,
        prevPosCount,
        lastWins:        lastN.filter((r) => r.pnl > 0).length,
        lastLosses:      lastN.filter((r) => r.pnl < 0).length,
        prevLosses,
        perSymbolOpen,
      }

      this.positionContextCache = { ctx, ts: now }
      return ctx
    } catch (err) {
      // Never fail the strategy flow on a context read error — fall back to
      // the neutral context so only the always-on `default` variant is made.
      console.warn(
        `[v0] [StrategyFlow] getPositionContext failed; using neutral context:`,
        err instanceof Error ? err.message : String(err),
      )
      const neutral = this.neutralPositionContext()
      this.positionContextCache = { ctx: neutral, ts: now }
      return neutral
    }
  }

  /**
   * Decide which variant profiles are ACTIVE for the current position context.
   * Each profile has a gate predicate — predicates that fail produce no
   * related Set for that variant this cycle (keeps work proportional to
   * context). The `default` variant is always on — it mirrors the original
   * one-Set-per-base behaviour and is what Real/Live have always consumed.
   *
   * ── P2-3: Closed-only contract for statistics-driven gates ────────
   * The `ctx` input here comes from `getPositionContext()`, which (as
   * of P2-1) enforces a strict `status==="closed"` filter on every
   * statistical field it builds:
   *   - prevPosCount, prevLosses, lastPosCount, lastWins, lastLosses
   *     → closed pseudo positions within a 24h lookback window.
   * Intentional exceptions (fields based on OPEN state by design, per
   * spec) — gates on these fields are NOT closed-only:
   *   - continuousCount  → # currently-open pseudo positions
   *                        (spec: "Continuous Positions" are active)
   *   - perSymbolOpen    → per-symbol open count (feeds `block` gate
   *                        which explicitly needs an open position to
   *                        continue into)
   * Every other axis used below is closed-only. This invariant keeps
   * Main-stage factor coordination free of floating mark-to-market
   * pollution while allowing the few gates that MUST reference live
   * open state to do so cleanly.
   */
  private selectActiveVariants(ctx: PositionContext): Array<ReturnType<StrategyCoordinator["variantProfiles"]>[number]> {
    return this.variantProfiles().filter((p) => p.gate(ctx))
  }

  /**
   * Curated variant profiles.
   *
   * Each profile contains a small list of configuration tuples (≤ 4 per
   * variant). Compared to the legacy 4×4×4 = 64 Cartesian expansion, this
   * produces at most ~16 candidate entries per base entry across all active
   * variants — a ~4× reduction in Main computation while preserving the
   * semantic coverage (each variant now produces a DEDICATED Set instead of
   * being scattered across one big hybrid Set).
   *
   * Gate predicates encode the user's coordination spec:
   *   default  — always on (validates & mirrors the Base Set)
   *   trailing — recent winners, no open position (scale-in opportunity)
   *   block    — there's an open position we can add to (continuation)
   *   dca      — recent losses to recover with averaged entries
   */
  private variantProfiles(): Array<{
    name: "default" | "trailing" | "block" | "dca" | "pause"
    gate: (ctx: PositionContext) => boolean
    configs: Array<{ size: number; leverage: number; state: string; pfBias: number; ddtBias: number }>
  }> {
    return [
      {
        name: "default",
        gate: () => true,
        configs: [
          { size: 1.0, leverage: 1, state: "new", pfBias: 1.00, ddtBias: 0  },
          { size: 1.0, leverage: 2, state: "new", pfBias: 1.05, ddtBias: 15 },
        ],
      },
      {
        name: "trailing",
        gate: (c) => c.lastWins >= 2 && c.continuousCount === 0,
        configs: [
          { size: 1.0, leverage: 3, state: "new", pfBias: 1.10, ddtBias: 30 },
          { size: 1.0, leverage: 5, state: "new", pfBias: 1.15, ddtBias: 60 },
        ],
      },
      {
        name: "block",
        // At least one open position, but don't let block stack indefinitely
        gate: (c) => c.continuousCount >= 1 && c.continuousCount < 3,
        configs: [
          { size: 1.5, leverage: 2, state: "add", pfBias: 1.08, ddtBias: 45 },
          { size: 2.0, leverage: 2, state: "add", pfBias: 1.12, ddtBias: 75 },
        ],
      },
      {
        name: "dca",
        gate: (c) => c.prevLosses >= 1,
        configs: [
          { size: 0.5, leverage: 1, state: "reduce", pfBias: 0.98, ddtBias: 20 },
          { size: 0.5, leverage: 1, state: "close",  pfBias: 0.95, ddtBias: 30 },
        ],
      },
      {
        // ── Pause variant — 1..8 last-position validation windows (step 1) ──
        // Spec: *"add Pause 1-8 Pos step 1 to Main additional Sets creation
        // after Pos prev,Last,cont .. add the 1-8 Last for counting Pause of
        // validating."* Each sub-config encodes one validation lookback N
        // (the last N closed positions) — when at least one of them was a
        // loser the Pause Set throttles back the next entry. The 8 sub-
        // configs ramp size DOWN and DDT-bias UP as the pause window
        // widens, so a deeper-history pause produces a more conservative
        // entry config than a shallow-history one. Gate fires whenever
        // there is ≥1 closed position to validate against; the closed-only
        // lookback enforced by `getPositionContext` (P2-1) means floating
        // mark-to-market PnL never leaks into this trigger.
        name: "pause",
        gate: (c) => c.lastPosCount >= 1,
        configs: [
          { size: 0.90, leverage: 1, state: "new", pfBias: 1.00, ddtBias: 5  }, // last 1
          { size: 0.85, leverage: 1, state: "new", pfBias: 1.00, ddtBias: 10 }, // last 2
          { size: 0.80, leverage: 1, state: "new", pfBias: 1.01, ddtBias: 15 }, // last 3
          { size: 0.75, leverage: 1, state: "new", pfBias: 1.02, ddtBias: 20 }, // last 4
          { size: 0.70, leverage: 1, state: "new", pfBias: 1.03, ddtBias: 25 }, // last 5
          { size: 0.65, leverage: 1, state: "new", pfBias: 1.04, ddtBias: 30 }, // last 6
          { size: 0.60, leverage: 1, state: "new", pfBias: 1.05, ddtBias: 35 }, // last 7
          { size: 0.55, leverage: 1, state: "new", pfBias: 1.06, ddtBias: 40 }, // last 8
        ],
      },
    ]
  }

  /**
   * Deterministic fingerprint of {base Set × variant × position context}.
   * Drives the "IF NOT ALREADY CREATED" dedup check.
   *
   * ── Bucket ranges (P0-3, spec-aligned) ─────────────────────────────
   * Spec ranges:
   *   - Prev Positions         1-12   (13 buckets 0-12)
   *   - Last Positions W/L     1-4    (5 buckets each 0-4)
   *   - Continuous Positions   1-10   (11 buckets 0-10)
   *
   * The previous implementation under-bucketed (Math.min(5,...) for all
   * three context dimensions), which collapsed distinct spec-level
   * contexts into the same cache entry and silently reused stale Sets.
   * Now each dimension is clamped to its spec maximum so every
   * semantically distinct context produces a distinct fingerprint.
   *
   * Coordinated-vars vs. materialised-Sets: we chose the coordinated
   * approach — each qualifying base Set expands into at most
   * 13×5×5×11 = 3,575 theoretical fingerprints, but in practice the
   * operator only visits O(20-80) of them per symbol per run. The
   * alternative (materialising Sets for every combo) would blow the
   * 250-entry cap and thrash Redis with no accuracy win.
   *
   * ── P2-3: Closed-only contract for statistics-driven buckets ──────
   * `lastWins`, `lastLosses`, `prevPosCount`, `prevLosses` below are
   * closed-only by construction (see `getPositionContext` P2-1 gate).
   * `continuousCount` is intentionally live — Continuous Positions
   * denote currently-open pseudo positions per spec.
   */
  private variantFingerprint(
    baseSet: StrategySet,
    variant: "default" | "trailing" | "block" | "dca" | "pause",
    ctx: PositionContext,
  ): string {
    const bPF = Math.round(baseSet.avgProfitFactor * 10) / 10
    const bEC = baseSet.entryCount
    // Clamp each context dimension to its spec maximum.
    // cont is live-open by spec; the other four are closed-only via
    // the P2-1 gate in getPositionContext. lastPosCount is the Pause
    // variant's primary discriminator (1..8 windows) — adding it to the
    // fingerprint guarantees a 3-loss / 5-loss / 8-loss pause produce
    // distinct cached Sets instead of collapsing into the same bucket.
    const cont = Math.min(10, Math.max(0, ctx.continuousCount))
    const lW   = Math.min(4,  Math.max(0, ctx.lastWins))
    const lL   = Math.min(4,  Math.max(0, ctx.lastLosses))
    const lP   = Math.min(8,  Math.max(0, ctx.lastPosCount))
    const pP   = Math.min(12, Math.max(0, ctx.prevPosCount))
    const pL   = Math.min(12, Math.max(0, ctx.prevLosses))
    const bCtx = `c${cont}/lw${lW}/ll${lL}/lp${lP}/pp${pP}/pl${pL}`
    return `${baseSet.setKey}#${variant}#pf=${bPF}#ec=${bEC}#ctx=${bCtx}`
  }

  /**
   * Build one related Main Set from a qualifying Base Set + variant profile.
   * Returns `null` if all candidate entries are rejected by the DDT cap or
   * the Set ends up empty (shouldn't normally happen at Main thresholds).
   */
  /**
   * Build a Main variant Set from a Base Set + variant profile.
   *
   * Now `async` because the prune step delegates to the shared
   * compaction policy (cached settings hash, async resolution). The
   * cache TTL keeps this effectively synchronous in steady state.
   */
  private async buildVariantSet(
    baseSet: StrategySet,
    profile: ReturnType<StrategyCoordinator["variantProfiles"]>[number],
    metrics: EvaluationMetrics,
    maxEntries: number,
    ctx?: PositionContext,
  ): Promise<StrategySet | null> {
    const entries: StrategySetEntry[] = []
    let idx = 0

    outer: for (const baseEntry of baseSet.entries) {
      for (const cfg of profile.configs) {
        if (idx >= maxEntries) break outer
        // Project the base entry through the variant config
        const pf  = Math.max(metrics.minProfitFactor, baseEntry.profitFactor * cfg.pfBias)
        const ddt = baseEntry.drawdownTime + cfg.ddtBias
        if (ddt > metrics.maxDrawdownTime) continue

        entries.push({
          id: `${baseSet.setKey}-${profile.name}-${idx}`,
          sizeMultiplier: cfg.size,
          leverage:       cfg.leverage,
          positionState:  cfg.state,
          profitFactor:   pf,
          drawdownTime:   ddt,
          // Confidence is preserved from the base entry — the variant changes
          // sizing/leverage/state, not the underlying signal quality.
          confidence:     Math.min(0.99, baseEntry.confidence),
        })
        idx++
      }
    }

    if (entries.length === 0) return null
    const capped = await this.pruneEntries(entries, maxEntries)
    const avgPF  = capped.reduce((s, e) => s + Number(e.profitFactor  || 0), 0) / capped.length
    const avgCnf = capped.reduce((s, e) => s + Number(e.confidence    || 0), 0) / capped.length
    const avgDDT = capped.reduce((s, e) => s + Number(e.drawdownTime  || 0), 0) / capped.length

    // ── Axis-window snapshot for this Set ───────────────────────────────
    // Mirrors the spec's four position-count axes with the documented
    // step-1 windows (see StrategySet.axisWindows). When ctx is absent
    // (legacy diagnostic call paths) we emit zeros, signalling "no axis
    // dimensioning available". The `last` axis encodes the *magnitude*
    // of the most recent dimensional skew (max of wins or losses) so a
    // single 0..4 figure suffices instead of two parallel counters.
    const axisWindows = ctx
      ? {
          prev:  Math.max(0, Math.min(12, ctx.prevPosCount)),
          last:  Math.max(0, Math.min(4,  Math.max(ctx.lastWins, ctx.lastLosses))),
          cont:  Math.max(0, Math.min(8,  ctx.continuousCount)),
          pause: Math.max(0, Math.min(8,  ctx.lastPosCount)),
        }
      : { prev: 0, last: 0, cont: 0, pause: 0 }

    return {
      // Variant-scoped setKey — `direction:long#default`, `direction:long#block`, …
      // This guarantees unique identity downstream so Real/Live treat each
      // variant as a distinct Set while still letting consumers trace
      // lineage via `parentSetKey`.
      setKey:          `${baseSet.setKey}#${profile.name}`,
      parentSetKey:    baseSet.setKey,
      variant:         profile.name,
      axisWindows,
      indicationType:  baseSet.indicationType,
      direction:       baseSet.direction,
      avgProfitFactor: avgPF,
      avgConfidence:   avgCnf,
      avgDrawdownTime: avgDDT,
      entryCount:      capped.length,
      entries:         capped,
      createdAt:       new Date().toISOString(),
    }
  }

  /**
   * Enforce max entries per Set using the shared threshold-compaction
   * policy (`lib/sets-compaction.ts`) in `mode: "best"`.
   *
   *   • Floor       = caller-provided `max` (so existing call sites that
   *                   compute their own per-Set max keep working).
   *   • thresholdPct= operator-controlled (Settings → System → Set
   *                   Compaction). Defaults to 20% per spec, so a
   *                   `max=250` floor admits up to 300 entries before
   *                   the compactor fires.
   *   • Mode "best" = stable-sort by PF desc, keep top floor, then
   *                   re-sort by timestamp asc so chronological order
   *                   is preserved downstream.
   *
   * The result is the same shape the legacy pruner returned (best-PF
   * first within the kept set) — but it only does the sort + slice
   * once every (ceiling - floor) calls instead of every call. Hot
   * paths that build a Set from many indications now see a meaningful
   * CPU drop on the prune step.
   *
   * `compactionThresholdPct` is read once and cached on the coordinator
   * instance — see `getCompactionThresholdPct`.
   */
  private async pruneEntries(entries: StrategySetEntry[], max: number): Promise<StrategySetEntry[]> {
    if (entries.length <= max) return entries
    const thresholdPct = await this.getCompactionThresholdPct()
    const cfg: CompactionConfig = { floor: max, thresholdPct }
    return compact(entries, cfg, "best", (e) => Number(e.profitFactor) || 0)
  }

  /** Cached threshold-pct lookup. 5s effective TTL via the underlying helper. */
  private _compactionThresholdPctCache: { v: number; t: number } | null = null
  private async getCompactionThresholdPct(): Promise<number> {
    const cache = this._compactionThresholdPctCache
    if (cache && Date.now() - cache.t < 5_000) return cache.v
    try {
      // Use the coordinator-entries pool key — it carries the operator's
      // intent for "how aggressively to keep entries within a single
      // Set". Falls back to the global threshold (20%) when nothing
      // is configured.
      const cfg = await loadCompactionConfig("coordinator.entries")
      this._compactionThresholdPctCache = { v: cfg.thresholdPct, t: Date.now() }
      return cfg.thresholdPct
    } catch {
      return 20
    }
  }

  /**
   * Log strategy progression through all stages
   */
  private async logStrategyProgression(symbol: string, results: StrategyEvaluation[]): Promise<void> {
    const summary = {
      symbol,
      stages: results.map((r) => ({
        type: r.type,
        sets: r.passedEvaluation,
        avgPF: r.avgProfitFactor.toFixed(2),
      })),
      totalLiveSets: results.find((r) => r.type === "live")?.passedEvaluation || 0,
    }

    try {
      await logProgressionEvent(this.connectionId, "strategy_flow", "info", `Strategy Sets flow: ${symbol}`, summary)
    } catch { /* non-critical */ }
  }
}
