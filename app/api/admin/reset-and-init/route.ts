import { NextResponse } from "next/server"
import { initRedis, getRedisClient, flushAll } from "@/lib/redis-db"
import { runMigrations } from "@/lib/redis-migrations"

export const runtime = "nodejs"

export async function POST() {
  try {
    console.log("[v0] === FLUSHING REDIS DATABASE ===")
    
    await initRedis()
    
    // Flush all data from Redis
    await flushAll()
    console.log("[v0] Redis database flushed")
    
    console.log("[v0] === RUNNING FRESH MIGRATIONS ===")
    
    // Run migrations fresh
    await runMigrations()
    console.log("[v0] Migrations completed")
    
    return NextResponse.json({
      success: true,
      message: "Redis database reset and initialized successfully",
      database_type: "redis",
    })
  } catch (error: any) {
    console.error("[v0] Reset and init failed:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Unknown error",
        database_type: "redis",
      },
      { status: 500 },
    )
  }
}
