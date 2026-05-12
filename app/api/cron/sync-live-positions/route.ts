import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"
import { reconcileLivePositions } from "@/lib/trade-engine/stages/live-stage"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * CRASH-RECOVERY / ENGINE-DOWN safety net for live positions.
 *
 * Purpose: reconcile positions for connections whose engine is NOT actively
 * running. When the engine IS running, the strategy coordinator already calls
 * `reconcileLivePositions` every 30 s (rate-limited, fire-and-forget from
 * within the strategy processor tick) — adding a cron reconcile on top of
 * that is redundant and doubles the exchange API calls.
 *
 * This cron fires once per minute and skips any connection whose engine
 * emitted a heartbeat within the last 90 seconds (`trade_engine_state.updated_at`).
 * It only performs a full reconcile for connections that are:
 *   a) marked live_trade=true (or have orphaned open positions), AND
 *   b) whose engine has been silent for > 90 s (crashed / stopped / restarting).
 *
 * `reconcileLivePositions` per call:
 *   - Detects positions missing from the exchange → marks closed, computes PnL,
 *     archives the record, releases the position lock so the engine can reopen.
 *   - Promotes `placed` positions to `open` if the exchange reports them filled.
 *   - Places / heals missing SL/TP orders.
 *   - Runs orphan-close sweep for positions exceeding max hold time.
 */
export async function GET() {
  const started = Date.now()
  await initRedis()
  const client = getRedisClient()

  // ── Overlap guard (atomic) ─────────────────────────────────────────
  //
  // Previous implementation:
  //     await client.set(LOCK_KEY, "1")
  //     await client.expire(LOCK_KEY, 55)
  //
  // — that pair is NOT a lock. `set` always succeeds and unconditionally
  // overwrites the existing value, so two concurrent invocations both
  // pass through and stack reconcile passes on top of each other. With a
  // slow exchange API + large connection pool the second invocation can
  // double-cancel orphan SL/TP orders and double-increment the
  // `live_positions_closed_count` counter (the moved-marker dedup
  // catches that one, but the wasted REST calls + log noise are real).
  //
  // We now use atomic `SET key value NX EX ttl`, which only succeeds
  // when the key did not previously exist. When acquisition fails we
  // return early with `skipped: true` — the next minute's tick will run
  // normally. TTL = 55s so a crashed run can never permanently block
  // the cron.
  const LOCK_KEY = "cron:sync-live-positions:lock"
  const acquired = await client.set(LOCK_KEY, String(started), { NX: true, EX: 55 })
  if (!acquired) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "another_invocation_in_progress",
      ms: Date.now() - started,
    })
  }

  const summary = {
    connectionsChecked: 0,
    connectionsSkipped: 0,
    positionsReconciled: 0,
    positionsClosed: 0,
    positionsUpdated: 0,
    errors: 0,
  }

  try {
    const connections = await getAllConnections()

    for (const conn of connections) {
      const connId: string =
        conn.id || conn.connection_id || conn.connectionId
      if (!connId) continue

      const settings = await client
        .hgetall(`connection:settings:${connId}`)
        .catch(() => ({} as Record<string, string>))

      const isLiveTrade =
        settings?.live_trade === "true" ||
        settings?.live_trade === "1" ||
        (conn as any).live_trade === true ||
        // Quickstart sets is_live_trade on the connection object directly.
        (conn as any).is_live_trade === "1" ||
        (conn as any).is_live_trade === true ||
        settings?.is_live_trade === "1"

      // Even when isLiveTrade is false, reconcile any connection that has
      // open positions tracked in Redis. This catches positions left over
      // from a previous quickstart run whose snapshot was restored but
      // the is_live_trade flag was not — the orders are still open on the
      // exchange and must be closed.
      const hasOpenPositions = !isLiveTrade
        ? (await client.llen(`live:positions:${connId}`).catch(() => 0)) > 0
        : false

      if (!isLiveTrade && !hasOpenPositions) {
        summary.connectionsSkipped++
        continue
      }

      // ── Engine-running guard ───────────────────────────────────────
      // If the engine is actively running for this connection, the strategy
      // coordinator's 30-second rate-limited reconcile already handles it.
      // Skip here to avoid redundant exchange API calls and double-arming
      // of SL/TP orders. We consider the engine "running" when its heartbeat
      // (`trade_engine_state.updated_at`) is within the last 90 seconds.
      const engineState = await client
        .hgetall(`trade_engine_state:${connId}`)
        .catch(() => ({} as Record<string, string>))
      const lastUpdatedAt = engineState?.updated_at
        ? new Date(engineState.updated_at).getTime()
        : 0
      const engineActiveRecently = Date.now() - lastUpdatedAt < 90_000
      if (engineActiveRecently) {
        summary.connectionsSkipped++
        continue
      }

      summary.connectionsChecked++

      try {
        const connector = await exchangeConnectorFactory.getOrCreateConnector(connId)
        if (!connector) {
          summary.connectionsSkipped++
          continue
        }

        const result = await reconcileLivePositions(connId, connector)
        summary.positionsReconciled += result.reconciled
        summary.positionsClosed      += result.closed
        summary.positionsUpdated     += result.updated
        summary.errors               += result.errors
      } catch (connErr) {
        summary.errors++
        console.warn(
          `[SyncLivePositions] ${connId} sync error:`,
          connErr instanceof Error ? connErr.message : String(connErr),
        )
      }
    }

    await client.del(LOCK_KEY).catch(() => {})
    return NextResponse.json({
      ok: true,
      ms: Date.now() - started,
      ...summary,
    })
  } catch (err) {
    console.error("[SyncLivePositions] Fatal:", err)
    await client.del(LOCK_KEY).catch(() => {})
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
        ...summary,
      },
      { status: 500 },
    )
  }
}
