/**
 * Shared Indication + Strategy Pipeline
 *
 * ── The single canonical inner pipeline used by BOTH the Prehistoric
 *    Progression and the Realtime Progression. ──
 *
 * Per the architectural spec:
 *
 *   "indications and strategies processings are in the same intervalled
 *    progress, for valid indication.. creating strategies Base Pseudo
 *    pos Sets continuing Stages Main, Real etc.. the open pseudo pos
 *    handling / update / close within sets is between indications and
 *    strategies processings (at strategies). indications and strategies
 *    progress is unique for both prehistoric and realtime (it processes
 *    through)."
 *
 * Strict 3-phase order per symbol per cycle:
 *
 *   Phase 1  — Indication evaluation.
 *              Calls IndicationProcessor.processIndication(symbol).
 *              Returns valid indications (or empty array).
 *
 *   Phase 2  — Open pseudo position handling (ALWAYS runs).
 *              Updates / closes all open pseudo positions for this
 *              symbol via RealtimeProcessor.updateOpenPseudoPositionsForSymbol.
 *              Per spec: pseudo position mark-to-market must run on EVERY
 *              cycle regardless of indication outcome — open positions
 *              never go un-managed.
 *
 *   Phase 3  — Strategy evaluation (gated on Phase 1).
 *              Only runs when Phase 1 produced at least one valid
 *              indication. Calls StrategyProcessor.processStrategy with
 *              the freshly-computed indications, which drives the
 *              BASE → MAIN → REAL → LIVE cascade and creates new
 *              pseudo positions where appropriate.
 *
 * ── Mode routing ──────────────────────────────────────────────────────
 * `mode: "historical" | "realtime"` is passed through to the underlying
 * processors. Today both processors handle the historical/realtime split
 * internally via separate method names (`processHistoricalIndications`
 * vs `processIndication`, `processHistoricalStrategies` vs
 * `processStrategy`). This pipeline routes to the correct method based
 * on mode so historical and realtime ticks write to their respective
 * Set keyspaces without contention.
 *
 * ── Coordination guarantees ───────────────────────────────────────────
 * Both A (Prehistoric) and B (Realtime) loops call this pipeline. They
 * are independent loops on independent timers, so a slow prehistoric
 * cycle never blocks a realtime cycle. Set writes are keyspaced by
 * mode, so the loops never race on the same Redis hash.
 */

import { IndicationProcessor } from "./indication-processor-fixed"
import { StrategyProcessor } from "./strategy-processor"
import type { RealtimeProcessor } from "./realtime-processor"

export type PipelineMode = "historical" | "realtime"

export interface PipelineCycleResult {
  symbol: string
  mode: PipelineMode
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
   * Optional timeframe window context for historical mode. Used by the
   * Prehistoric Progression to drive `processHistoricalIndications` /
   * `processHistoricalStrategies` with the look-back range derived
   * from the configured prehistoric_range_hours setting.
   */
  historicalWindow?: { start: Date; end: Date }
}

/**
 * Run the canonical 3-phase ind→pseudo→strat pipeline for a single
 * (connection, symbol) in the given mode. Returns a per-cycle result
 * record so the caller can aggregate telemetry across symbols.
 *
 * Errors are caught and recorded on the result object — they never
 * propagate. The caller's loop must remain alive even if one symbol
 * throws.
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
    indicationCount: 0,
    pseudoUpdates: 0,
    strategiesEvaluated: 0,
    liveReady: 0,
    durationMs: 0,
  }

  try {
    // ── Phase 1: Indication evaluation ────────────────────────────────
    // Historical mode fills the prev-set keyspace from the configured
    // look-back window. Realtime mode evaluates the current market
    // snapshot and returns the active indication list.
    let indications: any[] = []
    if (mode === "historical") {
      const window = deps.historicalWindow
      if (window) {
        // Historical method returns void; it writes Sets directly.
        // For Phase 3 we still need to pass indications, so we
        // re-fetch the freshly-written ones via the realtime method
        // afterwards (cheap — they're already in Redis hot cache).
        await deps.indication.processHistoricalIndications(symbol, window.start, window.end)
      }
      // Re-read the active indications so Phase 3 has something to
      // evaluate against. This is a single Redis hgetall + parse, no
      // recomputation.
      indications = await deps.indication.processIndication(symbol).catch(() => [] as any[])
    } else {
      indications = await deps.indication.processIndication(symbol).catch(() => [] as any[])
    }
    result.indicationCount = Array.isArray(indications) ? indications.length : 0

    // ── Phase 2: Open pseudo position handling (ALWAYS) ───────────────
    // Mark-to-market, TP/SL evaluation, trailing-stop ratchet, max-hold
    // force-close. Runs regardless of Phase 1 outcome so open positions
    // are never stranded without management.
    try {
      const pseudoUpdates = await deps.realtime.updateOpenPseudoPositionsForSymbol(symbol)
      result.pseudoUpdates = pseudoUpdates
    } catch (pseudoErr) {
      // Pseudo errors are isolated — they must not abort Phase 3 either.
      console.error(
        `[v0] [SharedPipeline] Pseudo update failed for ${symbol}:`,
        pseudoErr instanceof Error ? pseudoErr.message : String(pseudoErr),
      )
    }

    // ── Phase 3: Strategy evaluation (gated on Phase 1) ───────────────
    // Skip when Phase 1 produced no valid indications — running
    // StrategyProcessor against an empty indication set just churns
    // the strategy_cycle_count counter without producing any work.
    if (result.indicationCount > 0) {
      if (mode === "historical") {
        const window = deps.historicalWindow
        if (window) {
          await deps.strategy.processHistoricalStrategies(symbol, window.start, window.end)
        }
        // Historical writes are stage-internal; no per-cycle returns.
      } else {
        const stratResult = await deps.strategy
          .processStrategy(symbol, indications)
          .catch((err) => {
            console.error(
              `[v0] [SharedPipeline] Strategy failed for ${symbol}:`,
              err instanceof Error ? err.message : String(err),
            )
            return { strategiesEvaluated: 0, liveReady: 0 }
          })
        result.strategiesEvaluated = stratResult.strategiesEvaluated || 0
        result.liveReady = stratResult.liveReady || 0
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
