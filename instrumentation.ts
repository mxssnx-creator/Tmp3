// CRITICAL: Define totalStrategiesEvaluated globally BEFORE any other code loads
// This fixes ReferenceError in stale closures from previous code versions
// eslint-disable-next-line no-var
declare global { var totalStrategiesEvaluated: number }
;(globalThis as any).totalStrategiesEvaluated = 0

// Also clear any stale engine timers from previous versions
const engineGlobal = globalThis as any
if (engineGlobal.__engine_timers?.size > 0) {
  console.log(`[v0] [Instrumentation] Clearing ${engineGlobal.__engine_timers.size} stale engine timers`)
  for (const timer of engineGlobal.__engine_timers) {
    try { clearInterval(timer) } catch {}
  }
  engineGlobal.__engine_timers.clear()
}

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

  // NOTE: Migrations moved to first-request handler to avoid runtime errors
  // on platforms that don't support instrumentation well (like Vercel)
  
  return
}
