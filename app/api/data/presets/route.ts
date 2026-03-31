import { type NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"

interface PresetTemplate {
  id: string
  name: string
  description: string
  strategyType: string
  symbol: string
  enabled: boolean
  config: {
    tp: number
    sl: number
    leverage: number
    volume: number
  }
  stats: {
    winRate: number
    avgProfit: number
    successCount: number
  }
}

function generateMockPresets(connectionId: string): PresetTemplate[] {
  return [
    {
      id: `p1-${connectionId}`,
      name: "Bitcoin Momentum Long",
      description: "Aggressive momentum strategy for BTC",
      strategyType: "Momentum",
      symbol: "BTCUSDT",
      enabled: true,
      config: { tp: 8, sl: 0.5, leverage: 5, volume: 0.5 },
      stats: { winRate: 72, avgProfit: 3.2, successCount: 45 },
    },
    {
      id: `p2-${connectionId}`,
      name: "Ethereum Trend Follower",
      description: "Conservative trend-following for ETH",
      strategyType: "Trend",
      symbol: "ETHUSDT",
      enabled: true,
      config: { tp: 6, sl: 0.75, leverage: 3, volume: 0.75 },
      stats: { winRate: 68, avgProfit: 2.1, successCount: 38 },
    },
    {
      id: `p3-${connectionId}`,
      name: "Solana Volatility",
      description: "High volatility trading on SOL",
      strategyType: "Volatility",
      symbol: "SOLUSDT",
      enabled: false,
      config: { tp: 10, sl: 1, leverage: 10, volume: 0.25 },
      stats: { winRate: 55, avgProfit: 4.5, successCount: 22 },
    },
    {
      id: `p4-${connectionId}`,
      name: "Mean Reversion Multi",
      description: "Mean reversion across multiple pairs",
      strategyType: "Mean Reversion",
      symbol: "MULTI",
      enabled: true,
      config: { tp: 4, sl: 1.5, leverage: 2, volume: 1 },
      stats: { winRate: 65, avgProfit: 1.8, successCount: 52 },
    },
    {
      id: `p5-${connectionId}`,
      name: "Scalping Strategy",
      description: "High-frequency scalping template",
      strategyType: "Momentum",
      symbol: "BTCUSDT",
      enabled: false,
      config: { tp: 2, sl: 0.25, leverage: 20, volume: 0.1 },
      stats: { winRate: 58, avgProfit: 0.8, successCount: 120 },
    },
  ]
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    const connectionId = request.nextUrl.searchParams.get("connectionId")
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId query parameter required" }, { status: 400 })
    }

    // Determine if this is a demo connection or real connection
    const isDemo = connectionId === "demo-mode" || connectionId.startsWith("demo")

    let presets: PresetTemplate[] = []

    if (isDemo) {
      // Generate mock presets for demo mode
      presets = generateMockPresets(connectionId)
    } else {
      // For real connections, return empty array for now
      // This will be populated with real preset data from the trading engine in future iterations
      presets = []
    }

    return NextResponse.json({
      success: true,
      data: presets,
      isDemo,
      connectionId,
    })
  } catch (error) {
    console.error("[v0] Get presets error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
