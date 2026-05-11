import { type NextRequest, NextResponse } from "next/server"
import { flushAll, initRedis } from "@/lib/redis-db"
import { stopAllProgressionsBeforeReset } from "@/lib/db-reset-helper"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    console.log("[v0] Resetting Redis database...")

    await initRedis()

    // Stop every running engine, interval, and stale timer BEFORE wiping.
    // Otherwise an in-flight tick will write fresh progression rows back
    // into the DB between FLUSHALL and the next migration replay.
    const stopResult = await stopAllProgressionsBeforeReset()
    console.log("[v0] Progressions stopped before reset:", stopResult)

    await flushAll()

    console.log("[v0] Redis database reset successfully")

    return NextResponse.json({
      success: true,
      message: "Database reset successfully",
      stopped: stopResult,
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
