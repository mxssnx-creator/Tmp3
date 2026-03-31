"use server"

// Redis-based migrations - old SQLite file preserved for compatibility

export async function runAllMigrations() {
  return {
    success: true,
    applied: 0,
    skipped: 0,
    failed: 0,
    message: "Redis migrations handled automatically by redis-migrations.ts",
  }
}
