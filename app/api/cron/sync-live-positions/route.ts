import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"
import { reconcileLivePositions } from "@/lib/trade-engine/stages/live-stage"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Reconciles Redis-tracked live positions with each exchange.
 *
 * For every connection with live_trade=true, calls
 * `reconcileLivePositions(connId, connector)` which:
 *   - Refreshes mark price / liq price / unrealized PnL for positions still
 *     present on the exchange.
 *   - Marks positions missing from the exchange as "closed", computes realised
 *     PnL, moves them to the closed archive, increments win/close counters,
 *     and releases the per-symbol+direction lock so the engine can reopen.
 *
 * Safe to call frequently — the reconcile function issues a single batch
 * `getPositions()` per connection rather than per-symbol calls.
 */
export async function GET() {
  const started = Date.now()
  await initRedis()
  const client = getRedisClient()

  // Overlap guard: if a previous invocation is still running (e.g. slow
  // exchange API on a large connection pool), skip this tick rather than
  // stacking two reconcile passes on top of each other. TTL = 55s so a
  // crashed run never permanently blocks the cron.
  const LOCK_KEY = "cron:sync-live-positions:lock"
  const acquired = await client.set(LOCK_KEY, "1", "EX", 55, "NX")
  if (!acquired) {
    return NextResponse.json({ ok: true, skipped: true, reason: "previous run still active" })
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
        (conn as any).live_trade === true

      if (!isLiveTrade) {
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
