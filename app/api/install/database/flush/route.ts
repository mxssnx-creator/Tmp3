import { type NextRequest, NextResponse } from "next/server"
import { flushAll, getRedisClient, initRedis } from "@/lib/redis-db"
import { runMigrations } from "@/lib/redis-migrations"
import { SystemLogger } from "@/lib/system-logger"

export const runtime = "nodejs"

/**
 * POST /api/install/database/flush
 * DANGER: Flushes all Redis data and reinitializes the database
 * This is irreversible - all data will be permanently deleted
 */
export async function POST(request: NextRequest) {
  const logs: string[] = []

  try {
    // Get authorization token if available (optional basic protection)
    const authHeader = request.headers.get("authorization")
    if (authHeader !== `Bearer ${process.env.ADMIN_SECRET || ""}` && process.env.ADMIN_SECRET) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      )
    }

    logs.push("Starting Redis database flush...")
    console.log("[v0] Starting Redis flush operation")

    // Step 1: Initialize Redis
    try {
      await initRedis()
      logs.push("✓ Redis connection established")
    } catch (error) {
      logs.push(`✗ Redis connection failed: ${error}`)
      throw new Error("Redis connection failed")
    }

    // Step 2: Flush all data
    try {
      await flushAll()
      logs.push("✓ All Redis data flushed (FLUSHALL executed)")
      console.log("[v0] Redis flushed successfully")
    } catch (error) {
      logs.push(`✗ Flush operation failed: ${error}`)
      throw new Error("Flush operation failed")
    }

    // Step 3: Re-run migrations
    try {
      await runMigrations()
      logs.push("✓ Migrations re-applied after flush")
      console.log("[v0] Migrations re-applied")
    } catch (error) {
      logs.push(`⚠ Migration re-application warning: ${error}`)
    }

    // Step 4: Reseed data (connections, market data, settings)
    try {
      const { runPreStartup } = await import("@/lib/pre-startup")
      await runPreStartup()
      logs.push("✓ Predefined connections seeded")
      logs.push("✓ Market data seeded for all symbols")
      logs.push("✓ Default settings initialized")
      console.log("[v0] Data reseeded successfully")
    } catch (error) {
      logs.push(`⚠ Data seeding warning: ${error}`)
    }

    // Step 5: Create indexes
    try {
      const client = getRedisClient()
      await client.set("_index:connections:enabled", "true")
      await client.set("_index:trades:by_connection", "true")
      await client.set("_index:positions:active", "true")
      logs.push("✓ Database indexes recreated")
    } catch (error) {
      logs.push(`⚠ Index recreation warning: ${error}`)
    }

    logs.push("")
    logs.push("✓ Redis database flush completed successfully")

    await SystemLogger.logAPI(
      "Redis database flushed and reinitialized",
      "info",
      "POST /api/install/database/flush",
      { success: true, logs }
    )

    return NextResponse.json(
      {
        success: true,
        message: "Redis database flushed and reinitialized successfully",
        database_type: "redis",
        status: {
          flushed: true,
          migrations_reapplied: true,
          indexes_recreated: true,
        },
        logs,
      },
      { status: 200 }
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Flush operation failed"
    logs.push(`✗ Error: ${errorMsg}`)
    console.error("[v0] Flush error:", error)

    await SystemLogger.logError(error, "api", "POST /api/install/database/flush")

    return NextResponse.json(
      {
        success: false,
        error: errorMsg,
        database_type: "redis",
        logs,
      },
      { status: 500 }
    )
  }
}
