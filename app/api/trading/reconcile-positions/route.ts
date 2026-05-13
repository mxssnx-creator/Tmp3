import { NextResponse, type NextRequest } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getLivePositions, closeLivePosition } from "@/lib/trade-engine/stages/live-stage"
import { ExchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export const dynamic = "force-dynamic"

/**
 * Reconciliation endpoint that verifies live positions are actually open on the exchange.
 * Detects and fixes mismatches between DB and exchange state.
 *
 * Query params:
 *   connection_id  - connection to reconcile (required)
 *   threshold_ms   - positions older than this are checked (default 60000 = 1 min)
 */
export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const connectionId = searchParams.get("connection_id")
  const thresholdMs = parseInt(searchParams.get("threshold_ms") || "60000", 10)

  if (!connectionId) {
    return NextResponse.json(
      { success: false, error: "connection_id required" },
      { status: 400 }
    )
  }

  try {
    await initRedis()
    const connector = ExchangeConnectorFactory.getConnector(connectionId)
    if (!connector) {
      return NextResponse.json(
        { success: false, error: "Connector not found" },
        { status: 404 }
      )
    }

    console.log(`[v0] [Reconcile] Starting position reconciliation for ${connectionId}`)

    // Fetch all live positions from DB
    const livePositions = await getLivePositions(connectionId)
    const openPositions = livePositions.filter(p => p.status === "open" || p.status === "filled")

    console.log(`[v0] [Reconcile] Found ${openPositions.length} open positions in DB`)

    // Filter by age to avoid checking every position on every run
    const now = Date.now()
    const positionsToCheck = openPositions.filter(pos => {
      const createdAt = pos.createdAt || 0
      return (now - createdAt) > thresholdMs
    })

    console.log(`[v0] [Reconcile] Checking ${positionsToCheck.length} positions older than ${thresholdMs}ms`)

    const results = {
      checked: 0,
      stillOpen: 0,
      closedOnExchange: [] as Array<{ id: string; symbol: string; pnl?: number }>,
      errors: [] as string[],
    }

    // For each position, verify it's still open on the exchange
    for (const pos of positionsToCheck) {
      try {
        results.checked++

        // Fetch current position from exchange
        const exchangePositions = await connector.getOpenPositions(pos.symbol)
        const stillExists = exchangePositions.some(
          ep => ep.symbol === pos.symbol && ep.side === pos.direction
        )

        if (stillExists) {
          results.stillOpen++
          continue
        }

        // Position is closed on exchange but still open in DB
        console.warn(
          `[v0] [Reconcile] Found orphan position: ${pos.id} (${pos.symbol} ${pos.direction}) ` +
          `opened at ${new Date(pos.createdAt || 0).toISOString()}`
        )

        // Close it in DB to match exchange state
        const closePrice = pos.exchangeData?.markPrice || pos.entryPrice || 0
        if (closePrice > 0) {
          const closedPos = await closeLivePosition(
            connectionId,
            pos.id,
            closePrice,
            undefined, // No connector for reconciliation
            "exchange_reconciliation"
          )

          if (closedPos) {
            results.closedOnExchange.push({
              id: pos.id,
              symbol: pos.symbol,
              pnl: closedPos.realizedPnL,
            })
            console.log(
              `[v0] [Reconcile] Reconciled orphan position ${pos.id}: ` +
              `closed with PnL=${closedPos.realizedPnL?.toFixed(2)}`
            )
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.errors.push(`Position ${pos.id}: ${msg}`)
        console.error(`[v0] [Reconcile] Error checking position ${pos.id}:`, err)
      }
    }

    await logProgressionEvent(
      connectionId,
      "reconciliation",
      "info",
      `Position reconciliation complete`,
      {
        checked: results.checked,
        stillOpen: results.stillOpen,
        closedOnExchange: results.closedOnExchange.length,
        errors: results.errors.length,
      }
    )

    console.log(
      `[v0] [Reconcile] Complete: checked=${results.checked} still_open=${results.stillOpen} ` +
      `closed=${results.closedOnExchange.length} errors=${results.errors.length}`
    )

    return NextResponse.json({
      success: true,
      connectionId,
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[v0] [Reconcile] Fatal error:`, err)

    return NextResponse.json(
      {
        success: false,
        error: "Reconciliation failed",
        details: process.env.NODE_ENV === "development" ? msg : undefined,
      },
      { status: 500 }
    )
  }
}
