import { NextResponse } from "next/server"
import { getTradeEngine } from "@/lib/trade-engine"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/resume
 * Resume the Global Trade Engine Coordinator
 * Resumes all trading operations across all connections
 */
export async function POST() {
  try {
    const coordinator = getTradeEngine()

    if (!coordinator) {
      return NextResponse.json({ success: false, error: "Trade engine coordinator not initialized" }, { status: 503 })
    }

    await coordinator.resume()
    console.log("[v0] Global Trade Engine Coordinator resumed via API")

    return NextResponse.json({
      success: true,
      message: "Trade engine resumed successfully",
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Resume API error:", errorMessage)

    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 })
  }
}
