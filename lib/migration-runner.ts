import path from "path"
import fs from "fs"

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "database.db")

interface MigrationRecord {
  id: string
  name: string
  executedAt: string
}

const MIGRATIONS_TABLE = "migrations"

function getDatabase(): any {
  try {
    const { getClient } = require("./db")
    return getClient()
  } catch (error) {
    console.error("[v0] Failed to connect to database:", error)
    throw error
  }
}

function initMigrationsTable(db: any): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        executedAt TEXT NOT NULL
      )
    `)
    console.log("[v0] Migrations table initialized")
  } catch (error) {
    console.error("[v0] Failed to initialize migrations table:", error)
    throw error
  }
}

function getMigrationId(filename: string): string {
  return filename.replace(/\.sql$/, "")
}

function getExecutedMigrations(db: any): Set<string> {
  try {
    const migrations = db
      .prepare(`SELECT id FROM ${MIGRATIONS_TABLE}`)
      .all() as MigrationRecord[]
    return new Set(migrations.map((m) => m.id))
  } catch (error) {
    console.error("[v0] Failed to get executed migrations:", error)
    return new Set()
  }
}

function recordMigration(db: any, id: string, name: string): void {
  try {
    db.prepare(`
      INSERT INTO ${MIGRATIONS_TABLE} (id, name, executedAt)
      VALUES (?, ?, ?)
    `).run(id, name, new Date().toISOString())
  } catch (error) {
    console.error(`[v0] Failed to record migration ${id}:`, error)
    throw error
  }
}

export async function runMigrations(): Promise<void> {
  console.log("[v0] Starting database migrations...")

  let db: any | null = null

  try {
    db = getDatabase()

    initMigrationsTable(db)

    const migrationsDir = path.join(process.cwd(), "scripts")

    if (!fs.existsSync(migrationsDir)) {
      console.log("[v0] Migrations directory not found, skipping migrations")
      return
    }

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => {
        // Include all numbered migrations (e.g., 000_*, 001_*, etc.) and db-* files
        return (file.match(/^\d{3}_/) || file.startsWith("db-")) && file.endsWith(".sql")
      })
      .sort()

    const executedMigrations = getExecutedMigrations(db)

    if (migrationFiles.length === 0) {
      console.log("[v0] No migration files found")
      return
    }

    let migrationsRun = 0

    for (const file of migrationFiles) {
      const migrationId = getMigrationId(file)

      if (executedMigrations.has(migrationId)) {
        console.log(`[v0] Migration already executed: ${file}`)
        continue
      }

      const filePath = path.join(migrationsDir, file)
      const sql = fs.readFileSync(filePath, "utf-8")

      try {
        db.exec(sql)
        recordMigration(db, migrationId, file)
        console.log(`[v0] ✓ Migration executed: ${file}`)
        migrationsRun++
      } catch (error) {
        console.error(`[v0] ✗ Migration failed: ${file}`)
        console.error(`[v0] Error:`, error)
        throw error
      }
    }

    console.log(`[v0] Database migrations completed: ${migrationsRun} new migration(s) executed`)
  } catch (error) {
    console.error("[v0] Migration runner error:", error)
    throw error
  } finally {
    if (db) {
      db.close()
    }
  }
}
