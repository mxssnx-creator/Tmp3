/**
 * Fix script: patches redis-db.ts to export the Connection type,
 * and patches the 3 component files to use db-types instead.
 */
import { readFileSync, writeFileSync } from "fs"
import { resolve } from "path"

const ROOT = "/vercel/share/v0-project"

function patchFile(filePath, oldStr, newStr) {
  const content = readFileSync(filePath, "utf8")
  if (!content.includes(oldStr)) {
    console.log(`[SKIP] "${oldStr}" not found in ${filePath} (already patched or different)`)
    return
  }
  const patched = content.replace(oldStr, newStr)
  writeFileSync(filePath, patched, "utf8")
  console.log(`[OK] Patched ${filePath}`)
}

// 1. Patch redis-db.ts to export Connection type at the top
patchFile(
  resolve(ROOT, "lib/redis-db.ts"),
  `/**
 * Redis Database Layer
 * In-memory Redis client for Next.js runtime
 * Handles all database operations for connections, trades, positions, settings
 *
 * IMPORTANT: This file must NOT import 'fs' or 'path' as it's used by client components
 */

interface RedisData {`,
  `/**
 * Redis Database Layer
 * In-memory Redis client for Next.js runtime
 * Handles all database operations for connections, trades, positions, settings
 *
 * IMPORTANT: This file must NOT import 'fs' or 'path' as it's used by client components
 */

// Re-export shared types so callers can do: import type { Connection } from "@/lib/redis-db"
export type { Connection, Trade, Position } from "./db-types"

interface RedisData {`
)

// 2. Fix components that still import Connection from redis-db — change to db-types
const componentFiles = [
  resolve(ROOT, "components/settings/exchange-connection-manager.tsx"),
  resolve(ROOT, "components/dashboard/dashboard-active-connections-manager.tsx"),
  resolve(ROOT, "components/dashboard/active-connection-card.tsx"),
  resolve(ROOT, "lib/connection-state-helpers.ts"),
]

for (const filePath of componentFiles) {
  patchFile(
    filePath,
    `import type { Connection } from "@/lib/redis-db"`,
    `import type { Connection } from "@/lib/db-types"`
  )
  // Also handle relative import in connection-state-helpers
  patchFile(
    filePath,
    `import type { Connection } from './redis-db'`,
    `import type { Connection } from './db-types'`
  )
}

console.log("Done!")
