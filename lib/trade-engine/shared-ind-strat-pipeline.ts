/**
 * Shared Indication + Strategy Pipeline
 *
 * ── The single canonical inner pipeline used by BOTH the Prehistoric
 *    Progression and the Realtime Progression. ──
 *
 * Per the architectural spec:
 *
 *   "indications and strategies processings are in the same intervalled
 *    progress … indications and strategies progress is unique for both
 *    prehistoric and realtime (it processes through)."
 *
 * The two callers share IDENTICAL indication-derivation and strategy
 * code paths. The only behavioural difference is the `asOfMs` parameter
 * threaded through `processIndication`:
 *
 *   asOfMs === undefined  → Realtime mode. processIndication evaluates
 *                           the latest live candle in Redis hot keys
 *                           and stamps indications at wall-clock now.
 *                           Phase 2 marks live pseudo positions to the
 *                           current price.
 *
 *   asOfMs === number     → Replay mode. processIndication slices the
 *                           loaded candle history to <= asOfMs, treats
 *                           the tail candle as the simulated "current"
 *                           bar, and stamps indications at asOfMs. The
 *                           shared `indication_set:*` keyspace is
 *                           filled with the simulated bar. Phase 2 is
 *                           SKIPPED — backdated candles must never trip
 *                           TP/SL on live pseudo positions.
 *
 * ── Phase order per symbol per cycle ──────────────────────────────────
 *   Phase 1   processIndication(symbol, asOfMs?)            (both modes)
 *   Phase 1b  setsProcessor.processAllIndicationSets         (replay)
 *   Phase 2   updateOpenPseudoPositionsForSymbol            (realtime)
 *   Phase 3   processStrategy(symbol, indications)          (both modes,
 *             gated on indicationCount > 0)
 *
 * ── Coordination guarantees ───────────────────────────────────────────
 * Independent timers; a slow prehistoric cycle never blocks realtime.
 * Set keyspace `indication_set:{connId}:{symbol}:{type}:{cfg}` is SHARED:
 * Prehistoric writes (per replay step), Realtime reads (per live tick).
 * `processAllIndicationSets` is idempotent per `(symbol, candle.timestamp)`
 * so overlapping replay ranges across cycles are cheap and safe.
 */

import { IndicationProcessor } from "./indication-processor-fixed"
import { StrategyProcessor } from "./strategy-processor"
import type { RealtimeProcessor } from "./realtime-processor"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"

export type PipelineMode = "historical" | "realtime"

export interface PipelineCycleResult {
  symbol: string
  mode: PipelineMode
  asOfMs?: number
  indicationCount: number
  pseudoUpdates: number
  strategiesEvaluated: number
  liveReady: number
  durationMs: number
  error?: string
}

export interface PipelineDeps {
  indication: IndicationProcessor
  strategy: StrategyProcessor
  realtime: RealtimeProcessor
  /**
   * Replay-mode anchors (both required together for replay mode):
   *   asOfMs    — simulated wall-clock for this step (= candle.timestamp).
   *   asOfCandle — the candle object at that timestamp; passed straight
   *                into `processAllIndicationSets` so Sets-fill uses the
   *                exact same bar processIndication's slice tail sees.
   *   setsProcessor — optional shared IndicationSetsProcessor; the
   *                prehistoric tick allocates one per cycle and reuses
   *                it across all replay steps to avoid per-step churn.
   */
  asOfMs?: number
  asOfCandle?: any
  setsProcessor?: IndicationSetsProcessor
  /** Live stage exports — contains executeLivePosition for realtime order placement. */
  liveStage?: any
}

// ── Lazy-import cache for Phase 4 live-order path ───────────────────
// `executeReadyStrategiesAsLiveOrders` is the heavy Phase 4 that only
// fires when liveReady > 0 (typically < 10% of cycles). We still want
// dynamic imports so the 90% of ticks that don't enter Phase 4 pay
// nothing, but we memoize at module level so the 10% that DO enter
// resolve each import exactly once per process.
let __liveExecExports: {
  getConnection: any
  createExchangeConnector: any
} | null = null
async function __ensureLiveExecExports() {
  if (!__liveExecExports) {
    const [redisDb, connMod] = await Promise.all([
      import("@/lib/redis-db"),
      import("@/lib/exchange-connectors"),
    ])
    __liveExecExports = {
      getConnection: redisDb.getConnection,
      createExchangeConnector: connMod.createExchangeConnector,
    }
  }
  return __liveExecExports
}

async function executeReadyStrategiesAsLiveOrders(
  connectionId: string,
  symbol: string,
  liveStageExports: any,
): Promise<void> {
  try {
    const { getSettings, setSettings } = await import("@/lib/redis-db")
    const { executeLivePosition } = liveStageExports

    const realKey = `strategies:${connectionId}:${symbol}:real:sets`
    const stored = await getSettings(realKey)
    const realSets = stored?.sets || []

    if (realSets.length === 0) return

    const { getConnection, createExchangeConnector } = await __ensureLiveExecExports()
    const connection = await getConnection(connectionId).catch(() => null)
    if (!connection) {
      console.warn(`[v0] [Phase4] ${symbol}: connection ${connectionId} not found — skipping live orders`)
      return
    }
    const apiKey = (connection as any).api_key || (connection as any).apiKey || ""
    const apiSecret = (connection as any).api_secret || (connection as any).apiSecret || ""
    if (!apiKey || !apiSecret) {
      console.warn(`[v0] [Phase4] ${symbol}: no credentials on connection ${connectionId} — skipping live orders`)
      return
    }
    const exchangeConnector = await createExchangeConnector(connection.exchange, {
      apiKey,
      apiSecret,
      apiType: connection.api_type,
      contractType: connection.contract_type,
      isTestnet: connection.is_testnet === true || connection.is_testnet === "true",
    }).catch(() => null)
    if (!exchangeConnector) {
      console.warn(`[v0] [Phase4] ${symbol}: failed to create exchange connector for ${connection.exchange} — skipping`)
      return
    }

    // Track execution statistics for monitoring
    let createdCount = 0
    let failedCount = 0
    let totalEntries = 0

    // Convert each Real Set entry to an independent live order
    for (const realSet of realSets) {
      const entries = realSet.entries || []
      totalEntries += entries.length
      if (!entries || entries.length === 0) continue

      for (const entry of entries) {
        try {
          const realPosition = {
            id: `real:${connectionId}:${symbol}:${realSet.setKey}:${entry.id}:${Date.now()}`,
            connectionId,
            symbol,
            direction: realSet.direction || "long",
            quantity: Math.max(0.1, entry.sizeMultiplier || 1.0),
            entryPrice: 0,
            leverage: Math.max(1, Math.min(20, entry.leverage || 1)),
            stopLoss: realSet.stopLoss,
            takeProfit: realSet.takeProfit,
            trailingStop: realSet.trailingStop,
            trailingStepSize: realSet.trailingStepSize,
            maxHoldTime: realSet.maxHoldTime,
            setKey: realSet.setKey,
            parentSetKey: realSet.parentSetKey,
            variant: realSet.variant,
            axisWindows: realSet.axisWindows,
            entryConfidence: entry.confidence,
            entryProfitFactor: entry.profitFactor,
          }

          const livePos = await executeLivePosition(connectionId, realPosition, exchangeConnector)
          if (livePos?.status === "filled" || livePos?.status === "placed") {
            createdCount++
          } else {
            failedCount++
          }
        } catch (err) {
          failedCount++
          console.error(`[v0] [Phase4] ${symbol}: error=${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    if (createdCount > 0) {
      await setSettings(`live_execution:${connectionId}:${symbol}:latest`, {
        timestamp: new Date().toISOString(),
        created: createdCount,
        failed: failedCount,
      }).catch(() => {})
    }
  } catch (err) {
    console.error(`[v0] [Phase4] error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Run one full per-symbol pipeline pass. Errors are isolated to the
 * result object — they never propagate so the caller's loop survives.
 */
export async function runIndStratCycle(
  connectionId: string,
  symbol: string,
  mode: PipelineMode,
  deps: PipelineDeps,
): Promise<PipelineCycleResult> {
  const cycleStart = Date.now()
  const result: PipelineCycleResult = {
    symbol,
    mode,
    asOfMs: deps.asOfMs,
    indicationCount: 0,
    pseudoUpdates: 0,
    strategiesEvaluated: 0,
    liveReady: 0,
    durationMs: 0,
  }

  try {
    // ── Phase 1: Indication evaluation (UNIFIED) ──────────────────────
    // One method, both modes. asOfMs threads through to control which
    // candle slice and emission timestamp the processor uses.
    const indications = await deps.indication
      .processIndication(symbol, deps.asOfMs)
      .catch((err) => {
        console.error(
          `[v0] [SharedPipeline] processIndication failed for ${symbol} (mode=${mode}, asOfMs=${deps.asOfMs ?? "now"}):`,
          err instanceof Error ? err.message : String(err),
        )
        return [] as any[]
      })
    result.indicationCount = Array.isArray(indications) ? indications.length : 0

    // ── Phase 1b: Sets-fill (replay only) ─────────────────────────────
    // The shared `indication_set:*` keyspace is the bridge between the
    // two loops. Realtime reads it on every live tick; only Prehistoric
    // writes to it, and only on replay steps where we have an explicit
    // candle to attribute.
    if (mode === "historical" && deps.asOfCandle) {
      const setsProc = deps.setsProcessor ?? new IndicationSetsProcessor(connectionId)
      await setsProc
        .processAllIndicationSets(symbol, deps.asOfCandle)
        .catch((err) => {
          console.warn(
            `[v0] [SharedPipeline] Sets-fill warning for ${symbol} @${deps.asOfMs}:`,
            err instanceof Error ? err.message : String(err),
          )
        })
    }

    // ── Phase 2: Open pseudo position handling (REALTIME ONLY) ────────
    // Backdated candles must NEVER reach the pseudo-position close
    // engine — a 2-hour-old bar would trip TP/SL on every open paper
    // position instantly. Realtime mode marks against the live price.
    if (mode === "realtime") {
      try {
        const pseudoUpdates = await deps.realtime.updateOpenPseudoPositionsForSymbol(symbol)
        result.pseudoUpdates = pseudoUpdates
      } catch (pseudoErr) {
        console.error(
          `[v0] [SharedPipeline] Pseudo update failed for ${symbol}:`,
          pseudoErr instanceof Error ? pseudoErr.message : String(pseudoErr),
        )
      }
    }

    // ── Phase 3: Strategy evaluation (UNIFIED, gated on Phase 1) ──────
    // Same `processStrategy` for both modes. The BASE→MAIN→REAL→LIVE
    // coordinator behind it is responsible for any execution-side
    // gating (e.g. suppressing real-order placement during replay) by
    // inspecting the indication timestamp it receives.
    if (result.indicationCount > 0) {
      const stratResult = await deps.strategy
        .processStrategy(symbol, indications)
        .catch((err) => {
          console.error(
            `[v0] [SharedPipeline] processStrategy failed for ${symbol} (mode=${mode}):`,
            err instanceof Error ? err.message : String(err),
          )
          return { strategiesEvaluated: 0, liveReady: 0 }
        })
      result.strategiesEvaluated = stratResult.strategiesEvaluated || 0
      result.liveReady = stratResult.liveReady || 0

      // ── Phase 4: Execute ready Real Sets as live orders (realtime only) ──
      if (mode === "realtime" && result.liveReady > 0 && deps?.liveStage) {
        try {
          await executeReadyStrategiesAsLiveOrders(connectionId, symbol, deps.liveStage)
        } catch (err) {
          console.error(
            `[v0] [SharedPipeline] Live order execution error:`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    console.error(
      `[v0] [SharedPipeline] Cycle error for ${connectionId}/${symbol} (${mode}):`,
      result.error,
    )
  } finally {
    result.durationMs = Date.now() - cycleStart
  }

  return result
}
