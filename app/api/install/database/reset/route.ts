import { type NextRequest, NextResponse } from "next/server"
import { flushAll, initRedis } from "@/lib/redis-db"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    console.log("[v0] Resetting Redis database...")

    await initRedis()
    await flushAll()

    console.log("[v0] Redis database reset successfully")

    return NextResponse.json({
      success: true,
      message: "Database reset successfully",
    })
  } catch (error) {
    console.error("[v0] Database reset failed:", error)
    return NextResponse.json(
      {
        error: "Database reset failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
