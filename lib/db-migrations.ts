/**
 * Database Migrations - Deprecated
 * Redis migrations are now handled by redis-migrations.ts
 * This file is kept for backward compatibility only
 */

export interface Migration {
  id: number
  name: string
  sql: string
  executed: boolean
}

export class DatabaseMigrations {
  static async runMigrations(): Promise<{ success: boolean; applied: number; message: string }> {
    return {
      success: true,
      applied: 0,
      message: "Redis migrations handled automatically",
    }
  }
}
