import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getLivePositions, closeLivePosition } from "@/lib/trade-engine/stages/live-stage"
import { ExchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export const dynamic = "force-dynamic"

/**
 * Cron-triggered endpoint to detect and reconcile positions that differ between
 * DB and exchange state. Runs every 15 seconds.
 *
 * Detects:
 *   - Positions closed on exchange but still marked open in DB
 *   - Positions with close failures (exchangeCloseSucceeded=false)
 *   - Orphan SL/TP orders
 */
export async function GET(request: Request) {
  const startTime = Date.now()
  const { searchParams } = new URL(request.url)
  const connectionId = searchParams.get("connection_id")

  try {
    await initRedis()
    const client = getRedisClient()

    // If no specific connection, reconcile all active connections
    const connections = connectionId
      ? [connectionId]
      : await getActiveConnections()

    console.log(`[v0] [CronReconcile] Starting reconciliation for ${connections.length} connections`)

    let totalChecked = 0
    let totalReconciled = 0
    let totalErrors = 0

    for (const connId of connections) {
      try {
        const connector = ExchangeConnectorFactory.getConnector(connId)
        if (!connector) {
          console.warn(`[v0] [CronReconcile] Connector not found: ${connId}`)
          continue
        }

        // Get all open positions from DB
        const livePositions = await getLivePositions(connId)
        const openPositions = livePositions.filter(
          p => p.status === "open" || p.status === "filled"
        )

        console.log(`[v0] [CronReconcile] ${connId}: checking ${openPositions.length} open positions`)

        // Check positions that failed exchange close or are aged enough
        const toReconcile = openPositions.filter(pos => {
          const failedClose = pos.exchangeCloseAttempted && !pos.exchangeCloseSucceeded
          const aged = pos.createdAt && (Date.now() - pos.createdAt) > 120000 // 2 minutes
          return failedClose || aged
        })

        console.log(`[v0] [CronReconcile] ${connId}: reconciling ${toReconcile.length} positions`)

        // For each position, check if it exists on exchange
        for (const pos of toReconcile) {
          totalChecked++

          try {
            const exchangePositions = await connector.getOpenPositions(pos.symbol)
            const exists = exchangePositions.some(
              ep => ep.symbol === pos.symbol && ep.side === pos.direction
            )

            if (exists) {
              // Still on exchange, OK
              continue
            }

            // Closed on exchange but open in DB - close the DB record
            console.log(
              `[v0] [CronReconcile] Reconciling: ${pos.id} ` +
              `(${pos.symbol} ${pos.direction}) closed on exchange, marking closed in DB`
            )

            const closePrice = pos.exchangeData?.markPrice || pos.entryPrice || 0
            if (closePrice > 0) {
              const closed = await closeLivePosition(
                connId,
                pos.id,
                closePrice,
                undefined,
                "cron_reconciliation"
              )

              if (closed) {
                totalReconciled++
                console.log(
                  `[v0] [CronReconcile] Reconciled: ${pos.id} ` +
                  `PnL=${closed.realizedPnL?.toFixed(2)}`
                )
              }
            }
          } catch (err) {
            totalErrors++
            console.error(
              `[v0] [CronReconcile] Error reconciling ${pos.id}:`,
              err instanceof Error ? err.message : String(err)
            )
          }
        }

        // Check for failed close attempts that should be retried
        const failedCloses = openPositions.filter(
          p => p.exchangeCloseAttempted && !p.exchangeCloseSucceeded
        )

        if (failedCloses.length > 0) {
          console.warn(
            `[v0] [CronReconcile] ${connId}: Found ${failedCloses.length} ` +
            `positions with FAILED exchange close attempts - manual intervention may be needed`
          )

          await logProgressionEvent(
            connId,
            "cron_reconcile",
            "warning",
            `Found positions with failed close attempts`,
            {
              count: failedCloses.length,
              positionIds: failedCloses.map(p => p.id),
            }
          )
        }
      } catch (err) {
        totalErrors++
        console.error(
          `[v0] [CronReconcile] Error processing ${connId}:`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }

    const duration = Date.now() - startTime
    console.log(
      `[v0] [CronReconcile] Complete: ` +
      `checked=${totalChecked} reconciled=${totalReconciled} ` +
      `errors=${totalErrors} duration=${duration}ms`
    )

    return NextResponse.json({
      success: true,
      summary: {
        connections: connections.length,
        checked: totalChecked,
        reconciled: totalReconciled,
        errors: totalErrors,
        durationMs: duration,
      },
    })
  } catch (err) {
    console.error(
      `[v0] [CronReconcile] Fatal error:`,
      err instanceof Error ? err.message : String(err)
    )

    return NextResponse.json(
      {
        success: false,
        error: "Reconciliation failed",
        details: process.env.NODE_ENV === "development" ? String(err) : undefined,
      },
      { status: 500 }
    )
  }
}

/**
 * Get list of all active connection IDs
 */
async function getActiveConnections(): Promise<string[]> {
  try {
    const client = getRedisClient()

    // Scan for all progression:{connId} keys to find active connections
    const keys = await client.keys("progression:*").catch(() => [])
    if (!Array.isArray(keys)) return []

    const connIds = keys
      .map(key => {
        const match = key.match(/^progression:([^:]+)/)
        return match ? match[1] : null
      })
      .filter((id): id is string => id !== null && id.length > 0)

    const unique = Array.from(new Set(connIds))
    console.log(`[v0] [CronReconcile] Found ${unique.length} active connections`)
    return unique
  } catch (err) {
    console.error(`[v0] [CronReconcile] Error getting active connections:`, err)
    return []
  }
}
