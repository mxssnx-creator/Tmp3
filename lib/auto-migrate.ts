"use server"

import { getDatabaseType, query } from "@/lib/db"

let migrationRun = false

export async function runAutoMigrations() {
  // Only run once per server instance
  if (migrationRun) {
    return { success: true, message: "Migrations already applied" }
  }

  try {
    console.log("[v0] Running auto-migrations...")

    const dbType = getDatabaseType()

    // Skip auto-migrations - they're handled by the migration system
    // This function is kept for backward compatibility but migrations
    // should be added to the scripts/ folder instead
    console.log("[v0] Skipping auto-migrations (using migration system)")

    migrationRun = true
    return { success: true, message: "Auto-migrations skipped (using migration system)" }
  } catch (error) {
    console.error("[v0] Auto-migration failed:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
