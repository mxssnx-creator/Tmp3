import { NextResponse } from "next/server"
import { initRedis } from "@/lib/redis-db"
import { getMigrationStatus, runMigrations } from "@/lib/redis-migrations"

export async function GET() {
  try {
    await initRedis()
    const status = await getMigrationStatus()
    
    return NextResponse.json({
      current_version: status.latestVersion,
      target_version: 11,
      total_migrations: 11,
      message: status.message,
      is_up_to_date: status.latestVersion >= 11,
    })
  } catch (error) {
    console.error("[v0] Migrations info error:", error)
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Failed to get migrations info",
      current_version: 0,
    }, { status: 500 })
  }
}

export async function POST() {
  try {
    await initRedis()
    
    console.log("[v0] [API] Running migrations...")
    const result = await runMigrations()
    
    console.log("[v0] [API] Migrations completed:", result.message)
    
    return NextResponse.json({
      success: true,
      message: result.message,
      version: result.version,
    })
  } catch (error) {
    console.error("[v0] Migration run error:", error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Migration failed",
    }, { status: 500 })
  }
}
