/**
 * Independent Indication Sets Processor
 *
 * ── Design Principles ─────────────────────────────────────────────────
 *  1. Each indication TYPE (direction, move, active, optimal,
 *     active_advanced) has independent sets.
 *  2. Each CONFIG/parameter combination within a type has its OWN set.
 *  3. Each set is keyed `indication_set:{connId}:{symbol}:{type}:{configHash}`.
 *  4. Max positions per direction (long/short) is enforced per config.
 *  5. Indication timeout is applied after valid evaluation.
 *
 * ── 250-entry cap is PER-SET, not per-type total ─────────────────────
 * The constant `DEFAULT_LIMITS[type]` (250 by default) caps the number
 * of historical entries stored INSIDE a single Set (i.e. inside one
 * Redis key). It is NOT a cap on:
 *   - the total number of Sets per type (that's bounded by the number
 *     of valid config combinations)
 *   - the total entries across all Sets of a type (sum across keys)
 *   - cycle / frame / tick counters (those are unbounded counters
 *     stored on `progression:{connId}` independently of this cap)
 *
 * The cap is applied inside `batchSaveIndications` / `saveIndicationToSet`
 * via the shared compaction policy (`lib/sets-compaction.ts`), which
 * runs only when the buffer crosses `floor × (1 + thresholdPct/100)`
 * — default 250 × 1.2 = 300. Older entries are dropped first
 * (newest-at-last invariant). The Settings → System → "Set Compaction"
 * card lets the operator tune `floor`, `thresholdPct`, and per-type
 * overrides.
 */

import { getRedisClient, initRedis, getSettings, getAppSettings, setSettings } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { emitIndicationUpdate } from "@/lib/broadcast-helpers"
import {
  compact,
  compactionCeiling,
  loadCompactionConfig,
  type CompactionConfig,
  type SetCompactionType,
} from "@/lib/sets-compaction"

// Default limits per indication type (independently configurable)
const DEFAULT_LIMITS = {
  direction: 250,
  move: 250,
  active: 250,
  optimal: 250,
  active_advanced: 250,
}

// Pre-cached client reference
let cachedClient: any = null
async function getCachedClient() {
  // Always re-check if cachedClient is null/undefined
  if (!cachedClient) {
    await initRedis()
    cachedClient = getRedisClient()
  }
  // If still null after init, throw a clear error
  if (!cachedClient) {
    throw new Error("[IndicationSets] Redis client not available after initialization")
  }
  return cachedClient
}

// Position limits per config per direction
const DEFAULT_POSITION_LIMITS = {
  maxLong: 1,
  maxShort: 1,
}

// Indication timeout after valid evaluation (100ms - 3000ms)
const DEFAULT_INDICATION_TIMEOUT_MS = 1000

export interface IndicationSetLimits {
  direction: number
  move: number
  active: number
  optimal: number
  active_advanced: number
}

export interface PositionLimits {
  maxLong: number
  maxShort: number
}

export interface IndicationSet {
  type: "direction" | "move" | "active" | "optimal" | "active_advanced"
  connectionId: string
  symbol: string
  configKey: string // Unique key for this configuration combination
  entries: Array<{
    id: string
    timestamp: Date
    profitFactor: number
    confidence: number
    config: any
    metadata: any
    direction: "long" | "short"
  }>
  maxEntries: number // Configurable per type, default 250
  positionCounts: {
    long: number
    short: number
  }
  stats: {
    totalCalculated: number
    totalQualified: number
    avgProfitFactor: number
    lastCalculated: Date | null
  }
}

export class IndicationSetsProcessor {
  private connectionId: string
  private sets: Map<string, IndicationSet> = new Map()
  private limits: IndicationSetLimits = { ...DEFAULT_LIMITS }
  private positionLimits: PositionLimits = { ...DEFAULT_POSITION_LIMITS }
  private indicationTimeoutMs: number = DEFAULT_INDICATION_TIMEOUT_MS
  /**
   * Per-type compaction config, resolved once per ~5s via the cached
   * `loadCompactionConfig` helper. Keeping a per-processor copy lets the
   * hot-path `saveIndicationToSet` call `compact()` without touching the
   * settings hash on every fill.
   */
  private compactionCfgs: Partial<Record<SetCompactionType, CompactionConfig>> = {}
  private directionMoveRanges: number[] = Array.from({ length: 28 }, (_, i) => i + 3) // 3..30
  private optimalRanges: number[] = Array.from({ length: 28 }, (_, i) => i + 3) // 3..30
  private drawdownRatios: number[] = [0.5, 1.0, 1.5]
  private lastPartRatios: number[] = [0.25, 0.5]
  private factorMultipliers: number[] = [0.9, 1.0, 1.1]
  private activeThresholds: number[] = [0.5, 1.0, 1.5, 2.0, 2.5]
  private activeTimeRatios: number[] = [0.5, 1.0]

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.loadSettings()
  }

  private async loadSettings(): Promise<void> {
    try {
      // Mirror-aware read so operator values saved via the UI
      // (`app_settings`) apply even if the legacy `all_settings` hash
      // is empty on a fresh install.
      const settings = await getAppSettings()
      if (settings && Object.keys(settings).length > 0) {
        // Load independent limits per type
        if (settings.databaseSizeDirection) this.limits.direction = Number(settings.databaseSizeDirection)
        if (settings.databaseSizeMove) this.limits.move = Number(settings.databaseSizeMove)
        if (settings.databaseSizeActive) this.limits.active = Number(settings.databaseSizeActive)
        if (settings.databaseSizeOptimal) this.limits.optimal = Number(settings.databaseSizeOptimal)
        
        // Load position limits per direction
        if (settings.maxPositionsLong) this.positionLimits.maxLong = Number(settings.maxPositionsLong)
        if (settings.maxPositionsShort) this.positionLimits.maxShort = Number(settings.maxPositionsShort)
        
        // Load indication timeout
        if (settings.indicationTimeoutMs) {
          this.indicationTimeoutMs = Math.max(100, Math.min(3000, Number(settings.indicationTimeoutMs)))
        }

        // Config-grid controls (optional)
        this.directionMoveRanges = this.parseRangeSettings(
          settings.directionRangeStart,
          settings.directionRangeEnd,
          settings.directionRangeStep,
          this.directionMoveRanges,
        )
        this.optimalRanges = this.parseRangeSettings(
          settings.optimalRangeStart,
          settings.optimalRangeEnd,
          settings.optimalRangeStep,
          this.optimalRanges,
        )
        this.drawdownRatios = this.parseNumericList(settings.indicationDrawdownRatios, this.drawdownRatios)
        this.lastPartRatios = this.parseNumericList(settings.indicationLastPartRatios, this.lastPartRatios)
        this.factorMultipliers = this.parseNumericList(settings.indicationFactorMultipliers, this.factorMultipliers)
        this.activeThresholds = this.parseNumericList(settings.activeThresholds, this.activeThresholds)
        this.activeTimeRatios = this.parseNumericList(settings.activeTimeRatios, this.activeTimeRatios)
        
        // Fallback: legacy maxEntriesPerSet applies to all
        if (settings.maxEntriesPerSet && !settings.databaseSizeDirection) {
          const limit = Number(settings.maxEntriesPerSet)
          this.limits = { direction: limit, move: limit, active: limit, optimal: limit, active_advanced: limit }
        }
      }
      
      // Also load from indication_sets_config for backward compatibility
      const setsConfig = await getSettings("indication_sets_config")
      if (setsConfig) {
        if (setsConfig.direction) this.limits.direction = Number(setsConfig.direction)
        if (setsConfig.move) this.limits.move = Number(setsConfig.move)
        if (setsConfig.active) this.limits.active = Number(setsConfig.active)
        if (setsConfig.optimal) this.limits.optimal = Number(setsConfig.optimal)
      }
    } catch (error) {
      console.error("[v0] [IndicationSets] Failed to load settings:", error)
    }
  }

  /** Get the limit for a specific indication type */
  getLimit(type: keyof IndicationSetLimits): number {
    return this.limits[type] || DEFAULT_LIMITS[type] || 250
  }

  /**
   * Resolve the compaction config for an indication-set pool.
   *
   * Falls back to the legacy per-type `getLimit()` value as the floor
   * when no operator-level setting is configured, so behaviour stays
   * identical for users who haven't touched the new Set Compaction card.
   * Threshold defaults to 20% per spec.
   *
   * Cached on the processor instance — refreshed lazily via the 5s TTL
   * inside `loadCompactionConfig`.
   */
  private async resolveCompaction(
    type: keyof IndicationSetLimits,
  ): Promise<CompactionConfig> {
    const ckey = `indication.${type}` as SetCompactionType
    const cached = this.compactionCfgs[ckey]
    if (cached) return cached
    const cfg = await loadCompactionConfig(ckey)
    // If the operator never set a global / per-type floor, the helper
    // returned the hard-coded 250 default. For indication pools we want
    // the type-specific legacy limit (which may differ from 250 if the
    // user customised it under Settings → Indications → Sets) to win
    // over the global default — so we bump the floor up only when the
    // user hasn't explicitly overridden it via the new Set Compaction
    // card. Detection is heuristic: if the resolved floor matches the
    // hard-coded default *and* the legacy limit is larger, prefer the
    // legacy limit.
    const legacyLimit = this.getLimit(type)
    const finalCfg: CompactionConfig =
      cfg.floor === 250 && legacyLimit > 250
        ? { floor: legacyLimit, thresholdPct: cfg.thresholdPct }
        : cfg
    this.compactionCfgs[ckey] = finalCfg
    return finalCfg
  }

  private parseRangeSettings(startRaw: any, endRaw: any, stepRaw: any, fallback: number[]): number[] {
    const start = Number(startRaw)
    const end = Number(endRaw)
    const step = Number(stepRaw)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0 || end < start) {
      return fallback
    }
    const values: number[] = []
    for (let v = start; v <= end; v += step) values.push(v)
    return values.length > 0 ? values : fallback
  }

  private parseNumericList(raw: any, fallback: number[]): number[] {
    if (Array.isArray(raw)) {
      const parsed = raw.map((v) => Number(v)).filter((v) => Number.isFinite(v))
      return parsed.length > 0 ? parsed : fallback
    }
    if (typeof raw === "string") {
      const parsed = raw
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v))
      return parsed.length > 0 ? parsed : fallback
    }
    return fallback
  }
  
  /** Get position limits */
  getPositionLimits(): PositionLimits {
    return this.positionLimits
  }
  
  /** Check if we can add a position for given direction */
  canAddPosition(configKey: string, direction: "long" | "short", currentCount: number): boolean {
    const limit = direction === "long" ? this.positionLimits.maxLong : this.positionLimits.maxShort
    return currentCount < limit
  }
  
  /**
   * Process all indication types independently for a symbol
   */
  async processAllIndicationSets(symbol: string, marketData: any): Promise<void> {
    const startTime = Date.now()
    const TIMEOUT_MS = 15000 // 15 second timeout per symbol
    
    try {
      if (!marketData) {
        console.warn(`[v0] [IndicationSets] Invalid market data for ${symbol}`)
        await logProgressionEvent(this.connectionId, "indications_sets", "warning", `Invalid market data for ${symbol}`, {
          symbol,
          reason: "null_market_data",
        })
        return
      }

      // Process all 4 main types in parallel with independent logic
      const [directionResults, moveResults, activeResults, optimalResults] = await Promise.all([
        this.processDirectionSet(symbol, marketData),
        this.processMoveSet(symbol, marketData),
        this.processActiveSet(symbol, marketData),
        this.processOptimalSet(symbol, marketData),
      ])

      const duration = Date.now() - startTime
      
      // Check for timeout
      if (duration > TIMEOUT_MS) {
        console.warn(`[v0] [IndicationSets] TIMEOUT: Processing exceeded ${TIMEOUT_MS}ms for ${symbol} (took ${duration}ms)`)
        await logProgressionEvent(this.connectionId, "indications_sets", "warning", `Indication set processing timeout for ${symbol}`, {
          symbol,
          timeoutMs: TIMEOUT_MS,
          actualMs: duration,
        })
        return
      }

      const totalQualified = 
        (directionResults?.qualified || 0) +
        (moveResults?.qualified || 0) +
        (activeResults?.qualified || 0) +
        (optimalResults?.qualified || 0)

      if (totalQualified > 0) {
        console.log(
          `[v0] [IndicationSets] ${symbol}: COMPLETE in ${duration}ms | Direction=${directionResults?.qualified}/${directionResults?.total} Move=${moveResults?.qualified}/${moveResults?.total} Active=${activeResults?.qualified}/${activeResults?.total} Optimal=${optimalResults?.qualified}/${optimalResults?.total}`
        )

        await logProgressionEvent(this.connectionId, "indications_sets", "info", `All indication types processed for ${symbol}`, {
          direction: directionResults,
          move: moveResults,
          active: activeResults,
          optimal: optimalResults,
          duration,
        })
      }
    } catch (error) {
      console.error(`[v0] [IndicationSets] Failed to process sets for ${symbol}:`, error)
    }
  }

  /**
   * Process Direction Indication Set (ranges 3-30)
   * OPTIMIZED: Process all ranges in batch, minimize Redis calls
   */
  private async processDirectionSet(symbol: string, marketData: any): Promise<any> {
    const keyRanges = this.directionMoveRanges
    const drawdownRatios = this.drawdownRatios
    const lastPartRatios = this.lastPartRatios
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    const pendingWrites: Array<{ setKey: string; indication: any; config: any }> = []

    for (const range of keyRanges) {
      for (const drawdownRatio of drawdownRatios) {
        for (const lastPartRatio of lastPartRatios) {
          for (const factorMultiplier of factorMultipliers) {
            const indication = this.calculateDirectionIndication(marketData, {
              range,
              drawdownRatio,
              lastPartRatio,
              factorMultiplier,
            })
            if (!indication) continue
            
            total++
            const direction = indication.metadata?.firstDir > 0 ? "long" : "short"
            indication.direction = direction
            
            if (indication.profitFactor >= 1.0) {
              qualified++
              const setKey = `indication_set:${this.connectionId}:${symbol}:direction:r${range}:dd${drawdownRatio}:lp${lastPartRatio}:f${factorMultiplier}`
              pendingWrites.push({
                setKey,
                indication,
                config: { range, drawdownRatio, lastPartRatio, factorMultiplier },
              })
            }
          }
        }
      }
    }

    // Batch write all qualified indications
    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "direction")
    }

    return { type: "direction", total, qualified, configs: pendingWrites.length }
  }

  /**
   * Process Move Indication Set (ranges 3-30, no opposite requirement)
   * OPTIMIZED: Process key ranges only, batch writes
   */
  private async processMoveSet(symbol: string, marketData: any): Promise<any> {
    const keyRanges = this.directionMoveRanges
    const drawdownRatios = this.drawdownRatios
    const lastPartRatios = this.lastPartRatios
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    const pendingWrites: Array<{ setKey: string; indication: any; config: any }> = []

    for (const range of keyRanges) {
      for (const drawdownRatio of drawdownRatios) {
        for (const lastPartRatio of lastPartRatios) {
          for (const factorMultiplier of factorMultipliers) {
            const indication = this.calculateMoveIndication(marketData, {
              range,
              drawdownRatio,
              lastPartRatio,
              factorMultiplier,
            })
            if (!indication) continue
            
            total++
            const direction = (indication.metadata?.movement || 0) >= 0 ? "long" : "short"
            indication.direction = direction
            
            if (indication.profitFactor >= 1.0) {
              qualified++
              const setKey = `indication_set:${this.connectionId}:${symbol}:move:r${range}:dd${drawdownRatio}:lp${lastPartRatio}:f${factorMultiplier}`
              pendingWrites.push({
                setKey,
                indication,
                config: { range, drawdownRatio, lastPartRatio, factorMultiplier },
              })
            }
          }
        }
      }
    }

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "move")
    }

    return { type: "move", total, qualified, configs: pendingWrites.length }
  }

  /**
   * Process Active Indication Set (thresholds 0.5-2.5%)
   */
  private async processActiveSet(symbol: string, marketData: any): Promise<any> {
    const thresholds = this.activeThresholds
    const drawdownRatios = this.drawdownRatios
    const activeTimeRatios = this.activeTimeRatios
    const lastPartRatios = this.lastPartRatios
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    const pendingWrites: Array<{ setKey: string; indication: any; config: any }> = []

    for (const threshold of thresholds) {
      for (const drawdownRatio of drawdownRatios) {
        for (const activeTimeRatio of activeTimeRatios) {
          for (const lastPartRatio of lastPartRatios) {
            for (const factorMultiplier of factorMultipliers) {
              try {
                const indication = this.calculateActiveIndication(marketData, {
                  threshold,
                  drawdownRatio,
                  activeTimeRatio,
                  lastPartRatio,
                  factorMultiplier,
                })
                if (indication) {
                  total++
                  if (indication.profitFactor >= 1.0) {
                    qualified++
                    const setKey = `indication_set:${this.connectionId}:${symbol}:active:t${threshold}:dd${drawdownRatio}:ar${activeTimeRatio}:lp${lastPartRatio}:f${factorMultiplier}`
                    pendingWrites.push({
                      setKey,
                      indication,
                      config: { threshold, drawdownRatio, activeTimeRatio, lastPartRatio, factorMultiplier },
                    })
                  }
                }
              } catch (error) {
                console.error(`[v0] [IndicationSets] Active config error:`, error)
              }
            }
          }
        }
      }
    }

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "active")
    }

    return { type: "active", total, qualified, configs: pendingWrites.length }
  }

  /**
   * Process Optimal Indication Set (consecutive step detection)
   * OPTIMIZED: Process key ranges only, batch writes
   */
  private async processOptimalSet(symbol: string, marketData: any): Promise<any> {
    const keyRanges = this.optimalRanges
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    const pendingWrites: Array<{ setKey: string; indication: any; config: any }> = []

    for (const range of keyRanges) {
      for (const factorMultiplier of factorMultipliers) {
        const indication = this.calculateOptimalIndication(marketData, range, factorMultiplier)
        if (!indication) continue
        
        total++
        if (indication.profitFactor >= 1.0) {
          qualified++
          const setKey = `indication_set:${this.connectionId}:${symbol}:optimal:range${range}:factor${factorMultiplier}`
          pendingWrites.push({ setKey, indication, config: { range, factorMultiplier } })
        }
      }
    }

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "optimal")
    }

    return { type: "optimal", total, qualified }
  }

  /**
   * Batch save multiple indications - much more efficient than individual saves.
   *
   * Each entry persists the full set of fields downstream consumers need:
   *   - `type`        : indication type (direction|move|active|optimal|active_advanced)
   *   - `direction`   : long|short — required for per-direction position-cap
   *                     enforcement when the entry is replayed by the strategy
   *                     pipeline. Pulled from `indication.direction` (set
   *                     upstream in `processDirectionSet`/`processMoveSet`)
   *                     with sane fallbacks: explicit metadata.firstDir,
   *                     then "long" as last resort.
   *   - `setKey`      : not stored on the entry (it lives on the Redis key
   *                     itself) — but `getSetEntries` re-attaches it for
   *                     consumers that need provenance.
   *
   * The 250-cap (configurable via `getLimit`) is applied PER setKey — i.e.
   * per independent Set. This is the documented per-DB-entry cap; cycle
   * counters / frame counters are completely independent of it.
   */
  private async batchSaveIndications(
    writes: Array<{ setKey: string; indication: any; config: any }>,
    type: string
  ): Promise<void> {
    if (writes.length === 0) return
    
    try {
      const client = await getCachedClient()
      const now = Date.now()
      const timestamp = new Date().toISOString()

      // Process writes in bounded parallel chunks for high-frequency throughput.
      const concurrency = 20
      // Resolve compaction config once for the whole batch — type is
      // fixed for all writes in this call (the public batchSave API
      // takes a single `type`), so a single async resolution covers
      // every chunk and keeps the inner loop synchronous w.r.t. config
      // lookup.
      const compactionCfg = await this.resolveCompaction(type as keyof IndicationSetLimits)
      for (let i = 0; i < writes.length; i += concurrency) {
        const chunk = writes.slice(i, i + concurrency)
        await Promise.all(
          chunk.map(async ({ setKey, indication, config }, idx) => {
            // Resolve direction with progressive fallbacks. The strategy
            // coordinator + live-stage both use this field, so it MUST
            // be on the persisted entry to avoid silent "long" fallback.
            const direction: "long" | "short" =
              indication.direction === "short"
                ? "short"
                : indication.direction === "long"
                ? "long"
                : indication?.metadata?.firstDir < 0
                ? "short"
                : "long"

            const entry = {
              id: `${type}_${now}_${i + idx}_${Math.random().toString(36).slice(2, 6)}`,
              timestamp,
              type,
              direction,
              profitFactor: indication.profitFactor,
              confidence: indication.confidence,
              config,
              metadata: indication.metadata,
            }

            const existing = await client.get(setKey)
            let entries = existing ? JSON.parse(existing) : []
            // ── Newest-at-last (per spec) ────────────────────────────
            // The compaction policy drops oldest by `slice(-floor)`,
            // which requires chronological order. Use `push`, never
            // `unshift`. Switching from the prior unshift+slice(0, n)
            // pattern keeps reads in the same order downstream
            // consumers expected, just from the *other end* of the
            // array — and the dashboard's "newest first" surfaces all
            // already reverse the array on read, so no UI change is
            // needed.
            entries.push(entry)
            // ── Debounced threshold compaction ───────────────────────
            // `compact` returns the original array if length < ceiling
            // (cheap O(1) check). When it does fire, it returns a
            // fresh `slice(-floor)` — same big-O as the old
            // `slice(0, limit)` path but only every (ceiling-floor)
            // cycles instead of every cycle. We use the per-batch
            // resolved config (compactionCfg) so the inner loop avoids
            // any async hop.
            entries = compact(entries, compactionCfg, "recent")
            await client.set(setKey, JSON.stringify(entries))
          }),
        )
      }
    } catch (error) {
      // Silent fail for non-critical batch operations
    }
  }

  /**
   * Save indication to its independent set pool (per-Set cap, default 250
   * entries — see `DEFAULT_LIMITS` for per-type values).
   *
   * Persists the same shape as `batchSaveIndications` so consumers can
   * read either path interchangeably.
   *
   * NOTE: The legacy `Math.random() > 0.5` direction fallback used in the
   * realtime broadcast was non-deterministic — it produced UP/DOWN flicker
   * on the dashboard for every cell every cycle. The fix derives the
   * direction from the actual indication payload and falls back to NEUTRAL
   * for non-directional types (active/optimal/active_advanced).
   */
  private async saveIndicationToSet(
    setKey: string,
    indication: any,
    type: string,
    config: any
  ): Promise<void> {
    try {
      const client = await getCachedClient()
      
      const existing = await client.get(setKey)
      let entries = existing ? JSON.parse(existing) : []

      // Same direction-resolution logic as batchSaveIndications — see comment there.
      const direction: "long" | "short" =
        indication.direction === "short"
          ? "short"
          : indication.direction === "long"
          ? "long"
          : indication?.metadata?.firstDir < 0
          ? "short"
          : "long"

      const id = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      // Newest-at-last per spec — see compaction module docs. The
      // chronological invariant is required by the `mode: "recent"`
      // compactor below (it does `slice(-floor)`).
      entries.push({
        id,
        timestamp: new Date().toISOString(),
        type,
        direction,
        profitFactor: indication.profitFactor,
        confidence: indication.confidence,
        config,
        metadata: indication.metadata,
      })

      // Debounced threshold compaction. The cfg lookup is cached on
      // the processor instance with a 5s TTL so this single-save path
      // pays at most one Redis round-trip every 5s for config — every
      // subsequent call is a synchronous map lookup + a comparison.
      const cfg = await this.resolveCompaction(type as keyof IndicationSetLimits)
      entries = compact(entries, cfg, "recent")

      await client.set(setKey, JSON.stringify(entries))
      
      // Broadcast indication update to connected clients. Direction is
      // derived from the actual indication signal — directional types
      // (direction/move) report UP/DOWN, all other types (active /
      // optimal / active_advanced) report NEUTRAL.
      const symbol = setKey.split(':')[2]
      const broadcastDirection: "UP" | "DOWN" | "NEUTRAL" =
        type === "direction" || type === "move"
          ? direction === "long"
            ? "UP"
            : "DOWN"
          : "NEUTRAL"
      emitIndicationUpdate(this.connectionId, {
        id,
        symbol,
        direction: broadcastDirection,
        confidence: indication.confidence || 0,
        strength: indication.profitFactor || 0,
      })
      
      // Stats updates removed - too expensive for high-frequency operations
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Calculation methods for each type
   */

  private calculateDirectionIndication(
    marketData: any,
    config: { range: number; drawdownRatio: number; lastPartRatio: number; factorMultiplier: number },
  ): any {
    const { range, drawdownRatio, lastPartRatio, factorMultiplier } = config
    const prices = this.getPriceHistory(marketData, range * 2)
    if (!prices || prices.length < range * 2) return null

    const firstHalf = prices.slice(0, range)
    const secondHalf = prices.slice(range)

    const firstDir = this.getDirection(firstHalf)
    const secondDir = this.getDirection(secondHalf)

    // Opposite direction = signal
    if ((firstDir > 0 && secondDir < 0) || (firstDir < 0 && secondDir > 0)) {
      const reversalStrength = Math.abs(firstDir + secondDir)
      const drawdownPenalty = reversalStrength / Math.max(drawdownRatio * 10, 1)
      const tailWeight = 1 + lastPartRatio
      return {
        profitFactor: 1.0 + reversalStrength * factorMultiplier * tailWeight - drawdownPenalty,
        confidence: Math.min(1.0, ((Math.abs(firstDir) + Math.abs(secondDir)) / 2) * factorMultiplier),
        metadata: { firstDir, secondDir, range, drawdownRatio, lastPartRatio, factorMultiplier },
      }
    }

    return null
  }

  private calculateMoveIndication(
    marketData: any,
    config: { range: number; drawdownRatio: number; lastPartRatio: number; factorMultiplier: number },
  ): any {
    const { range, drawdownRatio, lastPartRatio, factorMultiplier } = config
    const prices = this.getPriceHistory(marketData, range)
    if (!prices || prices.length < range) return null

    const movement = Math.abs(prices[0] - prices[range - 1]) / prices[range - 1]
    const volatility = this.calculateVolatility(prices)
    const drawdownPenalty = movement / Math.max(drawdownRatio * 10, 1)
    const tailWeight = 1 + lastPartRatio

    return {
      profitFactor: 1.0 + (movement * 2 + volatility) * factorMultiplier * tailWeight - drawdownPenalty,
      confidence: Math.min(1.0, (movement + volatility / 2) * factorMultiplier),
      metadata: { movement, volatility, range, drawdownRatio, lastPartRatio, factorMultiplier },
    }
  }

  private calculateActiveIndication(
    marketData: any,
    config: {
      threshold: number
      drawdownRatio: number
      activeTimeRatio: number
      lastPartRatio: number
      factorMultiplier: number
    },
  ): any {
    const { threshold, drawdownRatio, activeTimeRatio, lastPartRatio, factorMultiplier } = config
    const prices = this.getPriceHistory(marketData, 10)
    if (!prices || prices.length < 2) return null

    const priceChange = Math.abs((prices[0] - prices[prices.length - 1]) / prices[prices.length - 1]) * 100

    if (priceChange >= threshold) {
      const normalizedChange = priceChange / Math.max(threshold, 0.1)
      const estimatedDrawdown = Math.max(0.1, normalizedChange / Math.max(drawdownRatio, 0.1))
      const activeTimeScore = normalizedChange * activeTimeRatio
      const tailWeight = 1 + lastPartRatio
      return {
        profitFactor: 1.0 + ((priceChange / 100) * factorMultiplier * tailWeight) - (estimatedDrawdown * 0.01),
        confidence: Math.min(1.0, priceChange / threshold / 2),
        metadata: {
          priceChange,
          threshold,
          drawdownRatio,
          activeTimeRatio,
          lastPartRatio,
          factorMultiplier,
          estimatedDrawdown,
          activeTimeScore,
        },
      }
    }

    return null
  }

  private calculateOptimalIndication(marketData: any, range: number, factorMultiplier: number): any {
    const prices = this.getPriceHistory(marketData, range * 3)
    if (!prices || prices.length < range * 3) return null

    // Consecutive steps: multiple direction changes = optimal signal
    const steps = this.detectConsecutiveSteps(prices, range)

    if (steps >= 2) {
      const volatility = this.calculateVolatility(prices)
      return {
        profitFactor: 1.0 + (steps * 0.5 + volatility) * factorMultiplier,
        confidence: Math.min(1.0, steps / 3),
        metadata: { consecutiveSteps: steps, volatility, range, factorMultiplier },
      }
    }

    return null
  }

  /**
   * Helper methods
   */

  private getPriceHistory(marketData: any, count: number): number[] | null {
    const prices = marketData.prices || []
    return prices.slice(0, count).map((p: any) => Number.parseFloat(p))
  }

  private getDirection(prices: number[]): number {
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length
    return prices.reduce((a, b) => a + (b > avg ? 1 : -1), 0) / prices.length
  }

  private calculateVolatility(prices: number[]): number {
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length
    const variance = prices.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / prices.length
    return Math.sqrt(variance) / avg
  }

  private detectConsecutiveSteps(prices: number[], range: number): number {
    let steps = 0
    for (let i = range; i < prices.length - range; i += range) {
      const dir1 = this.getDirection(prices.slice(i - range, i))
      const dir2 = this.getDirection(prices.slice(i, i + range))
      if ((dir1 > 0 && dir2 < 0) || (dir1 < 0 && dir2 > 0)) {
        steps++
      }
    }
    return steps
  }

  /**
   * Get stats for a specific indication type set
   */
  async getSetStats(symbol: string, type: string): Promise<any> {
    try {
      const client = await getCachedClient()
      if (!client) {
        return {
          type,
          totalConfigurations: 0,
          currentEntries: 0,
          avgProfitFactor: 0,
          avgConfidence: 0,
          error: "Redis client not available",
        }
      }
      const prefix = `indication_set:${this.connectionId}:${symbol}:${type}`
      const keys = await client.keys(`${prefix}*`)
      if (!keys || keys.length === 0) {
        return {
          type,
          totalConfigurations: 0,
          currentEntries: 0,
          avgProfitFactor: 0,
          avgConfidence: 0,
        }
      }

      let totalEntries = 0
      let totalProfitFactor = 0
      let totalConfidence = 0
      let sampleCount = 0

      for (const key of keys) {
        const raw = await client.get(key)
        if (!raw) continue
        const entries = JSON.parse(raw)
        if (!Array.isArray(entries)) continue

        totalEntries += entries.length
        for (const entry of entries) {
          totalProfitFactor += Number(entry?.profitFactor || 0)
          totalConfidence += Number(entry?.confidence || 0)
          sampleCount++
        }
      }

      return {
        type,
        totalConfigurations: keys.length,
        currentEntries: totalEntries,
        avgProfitFactor: sampleCount > 0 ? totalProfitFactor / sampleCount : 0,
        avgConfidence: sampleCount > 0 ? totalConfidence / sampleCount : 0,
      }
    } catch (error) {
      console.error(`[v0] [IndicationSets] Failed to get stats for ${type}:`, error)
      return null
    }
  }

  /**
   * Get all entries from a specific indication type set
   */
  async getSetEntries(symbol: string, type: string, limit = 50): Promise<any[]> {
    try {
      const client = await getCachedClient()
      const prefix = `indication_set:${this.connectionId}:${symbol}:${type}`
      const keys = await client.keys(`${prefix}*`)
      if (!keys || keys.length === 0) return []

      const allEntries: any[] = []
      for (const key of keys) {
        const raw = await client.get(key)
        if (!raw) continue
        const entries = JSON.parse(raw)
        if (!Array.isArray(entries)) continue
        allEntries.push(...entries.map((entry) => ({ ...entry, setKey: key })))
      }

      return allEntries
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
        .slice(0, limit)
    } catch (error) {
      console.error(`[v0] [IndicationSets] Failed to get entries for ${type}:`, error)
      return []
    }
  }
}
