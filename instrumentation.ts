// CRITICAL: Define totalStrategiesEvaluated globally BEFORE any other code loads
// This fixes ReferenceError in stale closures from previous code versions
// eslint-disable-next-line no-var
declare global { var totalStrategiesEvaluated: number }
;(globalThis as any).totalStrategiesEvaluated = 0

// NOTE: Previously this module pre-emptively cleared `globalThis.__engine_timers`
// on every import. That nuked the timer loops of any *live* engine that had
// already armed itself in the same process — a frequent cause of the
// "engines silently stop running" symptom on dev hot-reload and on serverless
// cold-warm transitions. The clear was always destructive and never useful:
// real timer cleanup belongs to `EngineManager.stop()`. The clear is now
// removed; in-flight engines keep running across module reload.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return
  }

  // Initialize production error handlers FIRST (before any other startup)
  try {
    const { default: ProductionErrorHandler } = await import("@/lib/error-handling-production")
    ProductionErrorHandler.initialize()
  } catch (error) {
    console.error("[ERROR_HANDLER] Failed to initialize production error handlers:", error)
  }

  // Initialize error handling integration (circuit breakers, metrics, etc.)
  try {
    const { initializeErrorHandling } = await import("@/lib/error-handling-integration")
    initializeErrorHandling()
  } catch (error) {
    console.error("[ERROR_INTEGRATION] Failed to initialize error handling integration:", error)
  }

  // ──────────────────────────────────────────────────────────────────────
  // Boot-time core init.
  //
  // 1. completeStartup(): initialises Redis (which runs migrations AND
  //    restores the on-disk snapshot via loadFromDisk) and prepares the
  //    trade-engine coordinator singleton — without auto-starting any
  //    engine. Without this hook the coordinator and snapshot only come
  //    online when someone hits a route, which can be many minutes after
  //    a redeploy.
  //
  // 2. initializeTradeEngineAutoStart(): starts the auto-start MONITOR
  //    only — it does NOT start engines on its own. The monitor scans for
  //    connections with `is_enabled_dashboard=1` and (re-)starts ONLY
  //    those, so disabled connections stay disabled across restarts.
  //
  // Failures here are logged but never thrown — boot must not crash the
  // runtime even if Redis hydration or the coordinator fail. Subsequent
  // route hits will retry.
  // ──────────────────────────────────────────────────────────────────────
  try {
    const { completeStartup } = await import("@/lib/startup-coordinator")
    await completeStartup()
  } catch (error) {
    console.error("[Instrumentation] completeStartup failed:", error)
  }

  try {
    const { initializeTradeEngineAutoStart } = await import("@/lib/trade-engine-auto-start")
    await initializeTradeEngineAutoStart()
  } catch (error) {
    console.error("[Instrumentation] auto-start init failed:", error)
  }

  // ── Patch VolumeCalculator.calculateVolumeForConnection ────────────
  // The webpack dev-server compiled this method into a stale eval() closure
  // with the old broken source (let balanceCap referenced let accountBalance
  // before it was declared — TDZ crash). Editing source files doesn't fix
  // the in-memory eval; only a process restart does. Since this
  // instrumentation register() runs once on boot, we patch the prototype
  // here so ALL callers — including the stale PseudoPositionManager
  // singleton — pick up the corrected implementation immediately.
  try {
    const { VolumeCalculator } = await import("@/lib/volume-calculator")
    const { getAppSettings, getSettings } = await import("@/lib/redis-db")

    ;(VolumeCalculator as any).prototype.calculateVolumeForConnection = async function(
      this: typeof VolumeCalculator,
      connectionId: string,
      symbol: string,
      currentPrice: number,
      options: { tradeMode?: string } = {},
    ) {
      try {
        const settings = (await getAppSettings()) || {}
        const positionCostPercent = parseFloat(
          String((settings as any).exchangePositionCost ?? (settings as any).positionCost ?? "0.1")
        )
        const positionCost = positionCostPercent / 100
        const positionsAverage = (() => {
          const raw = parseFloat(String((settings as any).positions_average ?? "2"))
          return Number.isFinite(raw) && raw > 0 ? raw : 2
        })()
        const leveragePercentage = parseFloat(String((settings as any).leveragePercentage ?? "100"))
        const useMaxLeverage =
          (settings as any).useMaximalLeverage === true ||
          (settings as any).useMaximalLeverage === "true"
        const rawLeverage = useMaxLeverage ? 125 : Math.round(125 * (leveragePercentage / 100))
        const { accountBalance, maxLeverage } =
          await VolumeCalculator.resolveBalanceAndLeverage(connectionId, rawLeverage)
        const tradingPair = await getSettings(`trading_pair:${symbol}`)
        const exchangeMinVolume = (tradingPair as any)?.min_order_size
          ? parseFloat((tradingPair as any).min_order_size)
          : undefined
        return VolumeCalculator.calculatePositionVolume({
          positionCost,
          positionsAverage,
          accountBalance,
          currentPrice,
          leverage: maxLeverage,
          exchangeMinVolume,
        })
      } catch (err) {
        console.error("[v0] [patch] calculateVolumeForConnection error:", err)
        throw err
      }
    }
    console.log("[Instrumentation] VolumeCalculator.calculateVolumeForConnection patched — TDZ fix applied")
  } catch (patchError) {
    console.error("[Instrumentation] Failed to patch VolumeCalculator:", patchError)
  }

  return
}
