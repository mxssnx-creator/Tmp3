import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

/**
 * GET /api/exchange/live-summary
 *
 * Aggregates LIVE exchange positions + account balance across every
 * enabled connection, for display in the QuickStart footer on the
 * dashboard.
 *
 * Position data source:
 *   positions:{connectionId}                (SET of position IDs)
 *   position:{connectionId}:{posId}          (HASH with position state)
 *
 * We only count positions with `status === "open"` AND `trade_mode`
 * indicating a live-exchange mode (i.e. not "paper" / "pseudo").
 *
 * Balance data source (best-effort):
 *   connection:{connectionId}:balance        (HASH: {total, available, equity, currency})
 * The exchange connector writes this hash after each trade/reconcile.
 * When it is missing we report zero for that connection rather than
 * erroring — the footer should never block the dashboard.
 *
 * Response shape is intentionally flat + cheap — the UI polls this
 * every ~10s so it needs to be snappy.
 */
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const connections = await getAllConnections()

    // Only enabled AND enabled-on-dashboard connections — these are the
    // ones the operator actually trades live on.
    const activeConns = connections.filter((c) => {
      const enabled   = c.is_enabled === "1" || c.is_enabled === true || c.is_enabled === "true"
      const dashOn    = c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true || c.is_enabled_dashboard === "true"
      return enabled && dashOn
    })

    if (activeConns.length === 0) {
      return NextResponse.json({
        connections: [],
        totals: {
          openPositions:  0,
          longPositions:  0,
          shortPositions: 0,
          unrealizedPnl:  0,
          totalBalance:   0,
          availableBalance: 0,
          equity:         0,
          currency:       "USDT",
        },
        updatedAt: Date.now(),
      })
    }

    // ── Fan out: gather positions + balance for every connection in parallel ─
    const perConnection = await Promise.all(
      activeConns.map(async (conn) => {
        const connId = conn.id
        const [posIds, balanceRaw] = await Promise.all([
          client.smembers(`positions:${connId}`).catch(() => [] as string[]),
          client.hgetall(`connection:${connId}:balance`).catch(() => ({} as Record<string, string>)),
        ])

        let openPositions  = 0
        let longPositions  = 0
        let shortPositions = 0
        let unrealizedPnl  = 0
        const positions: Array<{ symbol: string; side: string; qty: number; entry: number; mark: number; pnl: number }> = []

        if (Array.isArray(posIds) && posIds.length > 0) {
          // Batch fetch each position hash. Positions count grows O(connections
          // × openPositions) so we cap at 200 per connection as a safety guard.
          const capped = posIds.slice(0, 200)
          const positionHashes = await Promise.all(
            capped.map((id) =>
              client.hgetall(`position:${connId}:${id}`).catch(() => ({} as Record<string, string>)),
            ),
          )

          for (const p of positionHashes) {
            if (!p || Object.keys(p).length === 0) continue
            // Live = open + trade_mode NOT in {paper, pseudo, simulated}
            if (p.status !== "open") continue
            const mode = (p.trade_mode || "").toLowerCase()
            if (mode === "paper" || mode === "pseudo" || mode === "simulated") continue

            openPositions++
            const side = (p.side || "long").toLowerCase()
            if (side === "short") shortPositions++
            else                  longPositions++

            const pnl = Number(p.pnl ?? 0) || 0
            unrealizedPnl += pnl

            positions.push({
              symbol: p.symbol || "",
              side,
              qty:    Number(p.quantity ?? 0) || 0,
              entry:  Number(p.entry_price ?? 0) || 0,
              mark:   Number(p.current_price ?? p.mark_price ?? p.entry_price ?? 0) || 0,
              pnl,
            })
          }
        }

        // Balance hash: {total, available, equity, currency}. Fall back to 0.
        const total     = Number(balanceRaw?.total ?? 0)     || 0
        const available = Number(balanceRaw?.available ?? 0) || 0
        const equity    = Number(balanceRaw?.equity ?? total) || 0
        const currency  = (balanceRaw?.currency as string) || "USDT"

        return {
          connectionId: connId,
          name:         conn.name || conn.exchange_name || connId,
          exchange:     conn.exchange || conn.exchange_type || "",
          openPositions,
          longPositions,
          shortPositions,
          unrealizedPnl,
          balance: { total, available, equity, currency },
          positions: positions.slice(0, 20), // top 20 for UI; full list via /api/positions
        }
      }),
    )

    // ── Roll-up totals across every active connection ──────────────────────
    const totals = perConnection.reduce(
      (acc, c) => {
        acc.openPositions    += c.openPositions
        acc.longPositions    += c.longPositions
        acc.shortPositions   += c.shortPositions
        acc.unrealizedPnl    += c.unrealizedPnl
        acc.totalBalance     += c.balance.total
        acc.availableBalance += c.balance.available
        acc.equity           += c.balance.equity
        // First non-empty currency wins — all connections *should* be USDT
        // on Bybit/Binance derivatives; this is a display hint only.
        if (!acc.currency && c.balance.currency) acc.currency = c.balance.currency
        return acc
      },
      {
        openPositions: 0, longPositions: 0, shortPositions: 0,
        unrealizedPnl: 0, totalBalance: 0, availableBalance: 0,
        equity: 0, currency: "" as string,
      },
    )
    if (!totals.currency) totals.currency = "USDT"

    return NextResponse.json({
      connections: perConnection,
      totals,
      updatedAt: Date.now(),
    })
  } catch (error) {
    console.error("[v0] /api/exchange/live-summary error:", error)
    return NextResponse.json(
      {
        connections: [],
        totals: {
          openPositions: 0, longPositions: 0, shortPositions: 0,
          unrealizedPnl: 0, totalBalance: 0, availableBalance: 0,
          equity: 0, currency: "USDT",
        },
        updatedAt: Date.now(),
      },
      { status: 200 }, // never block the dashboard on this endpoint
    )
  }
}
