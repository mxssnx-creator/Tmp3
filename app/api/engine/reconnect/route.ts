import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { clearMarginCooldown } from "@/lib/trade-engine/stages/live-stage"
import { hasConnectionCredentials, isConnectionMainProcessing, isTruthyFlag } from "@/lib/connection-state-utils"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/engine/reconnect
 *
 * Lightweight self-heal trigger that:
 *   1. Clears the margin-error cooldown for all connections (or a specific
 *      one if `connectionId` is provided in the request body) so orders
 *      resume immediately without waiting for the exponential backoff to expire.
 *   2. Re-applies `is_enabled_dashboard="1"` for base connections that may
 *      have been accidentally zeroed out (migration race, clear-progressions, etc.).
 *   3. Calls `coordinator.startMissingEngines()` to restart any enabled
 *      connection whose engine dropped.
 *
 * This endpoint is intentionally idempotent and non-destructive — it does
 * NOT stop running engines, clear progression data, or reset trade history.
 * Use it as a "soft reconnect" when orders stop flowing or after topping up
 * the exchange balance.
 */
export async function POST(request: Request) {
  const startedAt = Date.now()
  try {
    await initRedis()
    const client = getRedisClient()

    // Optional: target a specific connection only.
    let targetConnectionId: string | null = null
    try {
      const body = await request.json().catch(() => ({}))
      if (body?.connectionId && typeof body.connectionId === "string") {
        targetConnectionId = body.connectionId
      }
    } catch { /* no body is fine */ }

    const log: string[] = []

    // ── 1. Clear margin-error cooldowns ───────────────────────────────
    if (targetConnectionId) {
      clearMarginCooldown(targetConnectionId)
      log.push(`Cleared margin cooldown for ${targetConnectionId}`)
    } else {
      // Clear for all base connections.
      const BASE_CONNECTION_IDS = ["bybit-x03", "bingx-x01"]
      for (const connId of BASE_CONNECTION_IDS) {
        clearMarginCooldown(connId)
      }
      log.push(`Cleared margin cooldowns for base connections`)
    }

    // ── 2. Re-apply base connection enabled flags ─────────────────────
    const BASE_CONNECTION_IDS = ["bybit-x03", "bingx-x01"]
    const connIdsToHeal = targetConnectionId ? [targetConnectionId] : BASE_CONNECTION_IDS
    let healed = 0
    for (const connId of connIdsToHeal) {
      try {
        const connData = await client.hgetall(`connection:${connId}`)
        if (!connData) continue
        if (connData.is_enabled_dashboard !== "1") {
          await client.hset(`connection:${connId}`, {
            is_enabled_dashboard: "1",
            is_active_inserted: "1",
            is_assigned: "1",
            is_enabled: "1",
            is_inserted: "1",
            is_active: "1",
          })
          await client.sadd("connections:main:enabled", connId)
          healed++
          log.push(`Restored dashboard_enabled=1 for ${connId}`)
        }
      } catch (err) {
        log.push(`Failed to heal ${connId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ── 3. Ensure global engine is running ────────────────────────────
    // If the engine is stopped (e.g. auto-stop after a code hot-reload, or a
    // previous explicit stop), the reconnect endpoint re-arms it. This is the
    // primary purpose of the "Reconnect" button: recover from any stopped state
    // without requiring a full QuickStart flow.
    const globalState = await client.hgetall("trade_engine:global")
    const globalIsRunning = globalState?.status === "running"
    if (!globalIsRunning) {
      const nowIso = new Date().toISOString()
      await client.hset("trade_engine:global", {
        status: "running",
        started_at: nowIso,
        coordinator_ready: "true",
        reconnected_at: nowIso,
      })
      log.push(`Set trade_engine:global status=running (was: ${globalState?.status ?? "missing"})`)

      // Also start the in-memory coordinator so engines spin up without
      // waiting for the next auto-start monitor tick (up to 30 s delay).
      try {
        const coordinator = getGlobalTradeEngineCoordinator()
        if (!coordinator.isRunning()) {
          await coordinator.start()
          log.push("Coordinator.start() called")
        }
      } catch (startErr) {
        log.push(`Coordinator.start() failed: ${startErr instanceof Error ? startErr.message : String(startErr)}`)
      }
    }

    // ── 3b. Live-patch VolumeCalculator to fix TDZ crash ─────────────
    // Route handlers are compiled fresh per-request in Next.js dev mode,
    // so this code runs from the current disk source (not the stale eval).
    // Overwriting the prototype method here fixes all existing singleton
    // instances because they share the same VolumeCalculator class reference.
    try {
      const { VolumeCalculator } = await import("@/lib/volume-calculator")
      const { getAppSettings: _gas, getSettings: _gs } = await import("@/lib/redis-db")

      // Called as static: VolumeCalculator.calculateVolumeForConnection(...)
      // Must patch on the class object itself, not on prototype.
      ;(VolumeCalculator as any).calculateVolumeForConnection = async function(
        connectionId: string,
        symbol: string,
        currentPrice: number,
        _options: Record<string, unknown> = {},
      ) {
        const settings = (await _gas()) || {}
        const positionCostPct = parseFloat(
          String((settings as any).exchangePositionCost ?? (settings as any).positionCost ?? "0.1")
        )
        const positionCost = positionCostPct / 100
        const posAvg = (() => {
          const r = parseFloat(String((settings as any).positions_average ?? "2"))
          return Number.isFinite(r) && r > 0 ? r : 2
        })()
        const levPct = parseFloat(String((settings as any).leveragePercentage ?? "100"))
        const useMax =
          (settings as any).useMaximalLeverage === true ||
          (settings as any).useMaximalLeverage === "true"
        const rawLev = useMax ? 125 : Math.round(125 * (levPct / 100))
        const { accountBalance, maxLeverage } =
          await VolumeCalculator.resolveBalanceAndLeverage(connectionId, rawLev)
        const tp = await _gs(`trading_pair:${symbol}`)
        const exMin = (tp as any)?.min_order_size
          ? parseFloat((tp as any).min_order_size)
          : undefined
        return VolumeCalculator.calculatePositionVolume({
          positionCost,
          positionsAverage: posAvg,
          accountBalance,
          currentPrice,
          leverage: maxLeverage,
          exchangeMinVolume: exMin,
        })
      }
      log.push("VolumeCalculator.calculateVolumeForConnection live-patched (TDZ fix applied)")
    } catch (patchErr) {
      log.push(
        `VolumeCalculator patch failed: ${patchErr instanceof Error ? patchErr.message : String(patchErr)}`
      )
    }

    // ── 4. Start any missing engines ──────────────────────────────────
    let startedCount = 0
    try {
      const connections = await getAllConnections()
      const eligible = connections.filter((c) => {
        if (targetConnectionId && c.id !== targetConnectionId) return false
        const isFullyEnabled = isConnectionMainProcessing(c)
        if (!isFullyEnabled) return false
        const hasAnyCredentials = hasConnectionCredentials(c, 5, true)
        const isPredefined = isTruthyFlag(c.is_predefined)
        const isTestnet = isTruthyFlag(c.is_testnet) || isTruthyFlag(c.demo_mode)
        return hasAnyCredentials || isPredefined || isTestnet
      })

      const coordinator = getGlobalTradeEngineCoordinator()
      startedCount = await coordinator.startMissingEngines(eligible)
      log.push(`startMissingEngines: ${startedCount} engines started (${eligible.length} eligible)`)
    } catch (err) {
      log.push(`startMissingEngines failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    return NextResponse.json({
      success: true,
      message: `Reconnect complete. ${healed} connections re-enabled, ${startedCount} engines started.`,
      log,
      healed,
      startedCount,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] [Reconnect] FATAL:", error)
    return NextResponse.json(
      { success: false, error: "Reconnect failed", details: errorMessage },
      { status: 500 },
    )
  }
}
