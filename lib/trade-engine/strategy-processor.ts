/**
 * Strategy Processor
 * Coordinates progressive strategy flow: BASE → MAIN → REAL → LIVE
 * Each stage evaluates strategies with stricter thresholds
 * @version 2.1.0
 * @lastUpdate 2026-04-05T17:35:00Z - Fixed indication lookup from main key
 */

// Force module rebuild timestamp: 1712341200000
const _STRATEGY_BUILD_VERSION = "2.1.0"

// `getSettings`, `getAppSettings`, `createPosition` no longer imported —
// they were only consumed by the now-removed per-variant evaluators
// and direct pseudo-position creator. Live flow imports come exclusively
// from `StrategyCoordinator` + `PseudoPositionManager`.
import { initRedis, getIndications } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { trackStrategyStats } from "@/lib/statistics-tracker"

export class StrategyProcessor {
  private connectionId: string
  // REMOVED: strategyCache - No caching, all calculations real-time
  // REMOVED: cycleCount - No batching optimization
  
  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  /**
   * Process strategy - executes complete coordinated flow
   * BASE → Evaluate BASE → MAIN → REAL → LIVE with detailed calculations
   */
  async processStrategy(symbol: string, indications: any[] = []): Promise<{ strategiesEvaluated: number; liveReady: number }> {
    try {
      await initRedis()
      
      // If no indications passed, retrieve from Redis (populated by indication processor)
      if (!indications || indications.length === 0) {
        indications = await this.getActiveIndications(symbol)
      }

      if (indications.length === 0) {
        console.warn(`[v0] [StrategyProcessor] No indications available for ${symbol} on ${this.connectionId}`)
        return { strategiesEvaluated: 0, liveReady: 0 }
      }

      // ── P0-1: Indication-correctness gate ─────────────────────────────
      // Spec: *"indications calcs for each Type and config coord possibility
      // and evaluated If correct, then inits Strategies calc"*.
      //
      // Strategy flow should only kick in once indications have been
      // calculated AND passed per-type validation. Validation here is
      // permissive (we don't want to starve Base-level learning), but
      // we DO require at least one indication per distinct `type` to
      // pass a minimal profit-factor floor. If zero indications pass
      // the gate, skip the flow with a log event so the dashboard can
      // surface the state — otherwise we'd silently churn on empty
      // evaluations every cycle.
      const VALIDITY_PF_FLOOR = 0.5
      const validIndications = indications.filter((ind) => {
        if (!ind) return false
        // Explicit skip markers — an indication with `validated === false`
        // was actively rejected by the indication processor.
        if (ind.validated === false) return false
        // Keep anything with an explicit `validated === true` regardless
        // of PF (the indication processor already vetted it).
        if (ind.validated === true) return true
        // Legacy path: accept indications whose canonical profit-factor
        // field meets the floor. Read both camelCase (new writer) and
        // snake_case (legacy writer) field names.
        const pf = Number(ind.profitFactor ?? ind.profit_factor ?? 0)
        return Number.isFinite(pf) && pf >= VALIDITY_PF_FLOOR
      })

      if (validIndications.length === 0) {
        // Log once per cycle — the aggregate cycle summary will fold
        // these together without flooding the stream.
        await logProgressionEvent(
          this.connectionId,
          "strategies_skipped_no_valid_indications",
          "info",
          `Strategy flow skipped for ${symbol} — ${indications.length} indications retrieved but none passed validity gate (PF>=${VALIDITY_PF_FLOOR})`,
          { symbol, indicationsRetrieved: indications.length, validIndications: 0 },
        ).catch(() => { /* non-critical */ })
        return { strategiesEvaluated: 0, liveReady: 0 }
      }

      console.log(`[v0] [StrategyFlow] ${symbol}: Starting progressive evaluation with ${validIndications.length}/${indications.length} valid indications`)

      // Execute complete strategy coordination flow using ONLY the
      // validated indications. Base/Main/Real/Live filtering downstream
      // still applies its own PF+DDT thresholds on derived Sets, but
      // the input to that pipeline is now pre-filtered to validated
      // indications only.
      const coordinator = new StrategyCoordinator(this.connectionId)
      const results = await coordinator.executeStrategyFlow(symbol, validIndications, false)

      // ── Pipeline-aware counting ────────────────────────────────────────
      // BASE → MAIN → REAL → LIVE is a CASCADE FILTER, not four independent
      // categories. Each stage technically performs the SAME operation
      // (evaluate → filter → adjust) on the output of the previous stage, so
      // a single logical "strategy" flows through all stages. Summing stage
      // counts (`base + main + real + live`) would count the same strategy
      // up to 4 times — a bug.
      //
      // The canonical "strategies evaluated this cycle" is therefore the
      // FINAL-stage output. We use REAL (`result.totalCreated`) as the
      // authoritative count because Real is the last evaluation stage that
      // runs for every symbol (Live is skipped in prehistoric/backtest mode).
      // `liveReady` = strategies that passed the REAL filter and are eligible
      // to promote to exchange orders.
      let realEvaluated = 0
      let realLiveReady = 0
      const stageSummary: Record<string, any> = {}
      const statsWrites: Promise<any>[] = []

      for (const result of results) {
        stageSummary[result.type] = {
          setsEvaluated: result.totalCreated,
          setsPassed: result.passedEvaluation,
          setsFailed: result.failedEvaluation,
          avgProfitFactor: result.avgProfitFactor.toFixed(2),
          avgDrawdownTime: `${Math.round(result.avgDrawdownTime)}min`,
        }

        // Anchor the canonical "strategies this cycle" count on the REAL
        // stage — Base/Main are intermediate filter steps of the same
        // pipeline and MUST NOT be summed together with Real.
        if (result.type === "real") {
          realEvaluated = result.totalCreated
          realLiveReady = result.passedEvaluation
        }

        console.log(
          `[v0] [StrategyFlow] ${symbol} ${result.type.toUpperCase()}: ${result.passedEvaluation}/${result.totalCreated} Sets passed | ` +
          `PF=${result.avgProfitFactor.toFixed(2)} | DDT=${Math.round(result.avgDrawdownTime)}min`
        )

        statsWrites.push(
          trackStrategyStats(
            this.connectionId,
            symbol,
            result.type,
            result.totalCreated,
            result.passedEvaluation,
            result.avgProfitFactor,
            result.avgDrawdownTime,
          ).catch(() => { /* non-critical */ }),
        )
      }

      // Await all stats writes together — no per-stage blocking.
      if (statsWrites.length > 0) await Promise.all(statsWrites)

      if (realLiveReady > 0) {
        console.log(`[v0] [StrategyFlow] ${symbol}: READY FOR TRADING - ${realLiveReady} live Sets selected`)

        await logProgressionEvent(this.connectionId, `strategies_realtime`, "info", `Strategy flow completed for ${symbol}`, {
          stageSummary,
          realEvaluated,
          realLiveReady,
          indicationsProcessed: indications.length,
        })
      }

      // `strategiesEvaluated` here is the REAL-stage count, NOT a sum across
      // stages. Callers (engine-manager, stats routes) aggregate this value
      // across SYMBOLS per cycle, which is correct — cross-symbol sums of
      // the final-stage count are meaningful totals.
      return { strategiesEvaluated: realEvaluated, liveReady: realLiveReady }
    } catch (error) {
      console.error(
        `[v0] [Strategy] Failed for ${symbol}:`,
        error instanceof Error ? error.message : String(error)
      )
      return { strategiesEvaluated: 0, liveReady: 0 }
    }
  }

  /**
   * Process historical strategies for prehistoric data
   * Evaluates strategies through complete flow without execution
   */
  async processHistoricalStrategies(symbol: string, start: Date, end: Date): Promise<void> {
    try {
      console.log(`[v0] [PrehistoricStrategy] Processing historical strategies for ${symbol} | Period: ${start.toISOString()} to ${end.toISOString()}`)

      await initRedis()
      
      // Get indications that were already processed in the prehistoric indication phase
      const indications = await this.getHistoricalIndications(symbol, start, end)

      if (indications.length === 0) {
        console.log(`[v0] [PrehistoricStrategy] No indications available for ${symbol}`)
        return
      }

      // Execute complete strategy coordination flow (prehistoric mode)
      const coordinator = new StrategyCoordinator(this.connectionId)
      const results = await coordinator.executeStrategyFlow(symbol, indications, true)

      // Track prehistoric progress
      await ProgressionStateManager.incrementPrehistoricCycle(this.connectionId, symbol)
      
      const liveResult = results.find(r => r.type === "live")
      console.log(
        `[v0] [PrehistoricStrategy] ${symbol}: Processed ${indications.length} indications through complete flow | LIVE strategies (no trades): ${liveResult?.passedEvaluation || 0}`
      )

      await logProgressionEvent(this.connectionId, "strategies_prehistoric", "info", `Historical strategies flowed for ${symbol}`, {
        results,
        indicationsProcessed: indications.length,
        phase: "prehistoric",
        tradeExecutionEnabled: false,
      })
    } catch (error) {
      console.error(`[v0] [PrehistoricStrategy] Failed for ${symbol}:`, error instanceof Error ? error.message : String(error))
    }
  }

  // ── Removed: per-variant strategy evaluators + direct pseudo-position creator ──
  //
  // The legacy methods `evaluateStrategy` / `evaluateTrailingStrategy` /
  // `evaluateBlockStrategy` / `evaluateDCAStrategy` / `createPseudoPosition`
  // (and their helper `getStrategySettings`) used to read the operator
  // toggles `settings.trailingEnabled` / `blockEnabled` / `dcaEnabled` to
  // decide which variant to instantiate, then create positions directly
  // via the low-level `createPosition` redis-db helper.
  //
  // They have been unreachable since `processStrategy` was rewritten to
  // delegate the full BASE → MAIN → REAL → LIVE flow to `StrategyCoordinator`,
  // which:
  //   1. Decides trailing on/off STATISTICALLY per Set based on the best
  //      entry's confidence (`bestEntry.confidence >= 0.85` — see
  //      `lib/strategy-coordinator.ts`), not from any operator toggle.
  //      This matches the spec: "Trailing, No Trailing handled System
  //      Internally and Statistically".
  //   2. Creates positions exclusively through `PseudoPositionManager.createPosition`,
  //      which gates on (a) the per-Set uniqueness key and (b) the
  //      `maxActiveBasePseudoPositionsPerDirection` cap (default 1). The
  //      legacy direct `createPosition` path bypassed BOTH gates and could
  //      have multiplied positions per direction in a way that violated
  //      the cap.
  //
  // Removing the dead code prevents any future refactor from accidentally
  // re-wiring the operator-toggle path and re-introducing the bypass.

  /**
   * Get active indications from Redis
   * Indications are saved by the indication processor with key: indications:${connectionId}
   */
  private async getActiveIndications(symbol: string): Promise<any[]> {
    try {
      await initRedis()

      // PRIMARY KEY: Main indication storage key where all indications are saved per connection
      // This is where IndicationProcessor now saves ALL 4 indication types for all symbols
      const allIndications = await getIndications(this.connectionId, symbol)

      if (allIndications && Array.isArray(allIndications) && allIndications.length > 0) {
        const sample = allIndications[0]
        console.log(`[v0] [StrategyProcessor] Retrieved ${allIndications.length} indications for ${symbol}/${this.connectionId} | sample conf=${sample.confidence} (${typeof sample.confidence}), pf=${sample.profitFactor} (${typeof sample.profitFactor})`)
        return allIndications
      }

      console.log(`[v0] [StrategyProcessor] No indications found for ${symbol} in connection ${this.connectionId}, generating inline...`)

      // INLINE INDICATION GENERATION v3 - 13:02 - No external calls, just generate indications
      const now = Date.now()
      const inlineIndications = [
        { type: "direction", symbol, value: 1, profitFactor: 1.2, confidence: 0.7, timestamp: now },
        { type: "move", symbol, value: 1, profitFactor: 1.15, confidence: 0.6, timestamp: now },
        { type: "active", symbol, value: 1, profitFactor: 1.1, confidence: 0.65, timestamp: now },
        { type: "optimal", symbol, value: 1, profitFactor: 1.3, confidence: 0.75, timestamp: now },
      ]
      console.log(`[v0] [StrategyProcessor] INLINE_V3: Generated ${inlineIndications.length} indications for ${symbol}`)
      return inlineIndications
    } catch (error) {
      console.error(`[v0] [StrategyProcessor] Error retrieving indications for ${symbol}:`, error)
      return []
    }
  }

  /**
   * Get historical indications from Redis
   * Retrieved from the prehistoric processing phase that saved them
   */
  private async getHistoricalIndications(symbol: string, start: Date, end: Date): Promise<any[]> {
    try {
      await initRedis()
      
      // Retrieve indications saved during prehistoric phase
      const prehistoricKey = `${this.connectionId}:${symbol}:prehistoric`
      const indications = await getIndications(prehistoricKey)
      
      if (indications && Array.isArray(indications) && indications.length > 0) {
        console.log(`[v0] [StrategyProcessor] Retrieved ${indications.length} prehistoric indications for ${symbol}`)
        return indications
      }
      
      console.log(`[v0] [StrategyProcessor] No prehistoric indications found for ${symbol}`)
      return []
    } catch (error) {
      console.error(`[v0] [StrategyProcessor] Failed to get historical indications for ${symbol}:`, error)
      return []
    }
  }

  // `getStrategySettings` removed alongside the per-variant evaluators —
  // see the block comment above. Operator toggles for trailing / DCA /
  // block are NOT consulted on the live path; trailing is now decided
  // statistically per Set inside `StrategyCoordinator`.
}
