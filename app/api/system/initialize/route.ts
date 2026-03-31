import { NextResponse } from "next/server"
import { ensureDefaultExchangesExist } from "@/lib/default-exchanges-seeder"
import { initRedis, getAllConnections } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"

function toBoolean(value: unknown): boolean {
  return value === true || value === "1" || value === "true"
}

export async function GET() {
  console.log("[v0] System initialization starting...")

  try {
    // Initialize Redis
    await initRedis()
    console.log("[v0] Redis initialized")

    // Seed default exchanges
    const seedResult = await ensureDefaultExchangesExist()
    if (!seedResult.success) {
      console.warn("[v0] Warning: Could not seed default exchanges:", seedResult.error)
    }

    // Get all connections
    const allConnections = await getAllConnections()
    const enabledConnections = allConnections?.filter((c) => toBoolean(c.is_enabled)) || []
    const predefinedConnections = allConnections?.filter((c) => toBoolean(c.is_predefined)) || []

    await SystemLogger.logAPI("System initialized successfully", "info", "GET /api/system/initialize", {
      totalConnections: allConnections?.length,
      enabledConnections: enabledConnections.length,
      predefinedConnections: predefinedConnections.length,
    })

    return NextResponse.json({
      success: true,
      message: "System initialized successfully",
      status: {
        redis: "connected",
        defaultExchangesSeeded: seedResult.success,
        connections: {
          total: allConnections?.length || 0,
          enabled: enabledConnections.length,
          predefined: predefinedConnections.length,
        },
        timestamp: new Date().toISOString(),
      },
    })
  } catch (error) {
    console.error("[v0] System initialization failed:", error)
    await SystemLogger.logError(error, "api", "GET /api/system/initialize")

    return NextResponse.json(
      {
        success: false,
        error: "System initialization failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
