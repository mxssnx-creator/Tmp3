import { NextResponse } from "next/server"
import { getLivePositions } from "@/lib/trade-engine/stages/live-stage"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const connectionId = searchParams.get("connection_id") || "bingx-x01"

  try {
    await initRedis()

    // Get live positions from live-stage store
    const positions = await getLivePositions(connectionId)

    // Also scan for any positions stored under alternate key patterns
    const client = getRedisClient()
    const altKeys = await client.keys(`live:position:live:${connectionId}:*`).catch(() => [] as string[])
    const altPositions: any[] = []
    for (const key of altKeys) {
      try {
        const raw = await client.get(key)
        if (raw) {
          const p = JSON.parse(raw)
          // Avoid duplicates with positions already returned by getLivePositions
          if (!positions.find(existing => existing.id === p.id)) {
            altPositions.push(p)
          }
        }
      } catch { /* skip malformed */ }
    }

    const all = [...positions, ...altPositions]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

    return NextResponse.json({
      connectionId,
      positions: all,
      counts: {
        total: all.length,
        open: all.filter(p => p.status === "open").length,
        pending: all.filter(p => p.status === "pending").length,
        filled: all.filter(p => p.status === "filled").length,
        simulated: all.filter(p => p.status === "simulated").length,
        closed: all.filter(p => p.status === "closed").length,
        error: all.filter(p => p.status === "error").length,
      },
    })
  } catch (err) {
    console.warn("[v0] [LivePositions API] Error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ connectionId, positions: [], counts: { total: 0 } })
  }
}
