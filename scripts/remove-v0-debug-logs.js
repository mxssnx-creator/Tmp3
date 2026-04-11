/**
 * Removes all console.log/warn("[v0] ...") debug statements from source files.
 * Uses simple string includes() to avoid regex escaping issues with backticks.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs"
import { join, extname } from "path"

const ROOT = "/vercel/share/v0-project"

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "scripts", "backup", "docs", "public",
])

/**
 * Returns true if this line is a standalone console.log or console.warn
 * that starts with the [v0] debug prefix and has no other side effects.
 */
function isDebugLogLine(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith("console.log(") && !trimmed.startsWith("console.warn(")) {
    return false
  }
  // Must contain [v0] as the first part of the string argument
  if (
    trimmed.includes("console.log(`[v0]") ||
    trimmed.includes('console.log("[v0]') ||
    trimmed.includes("console.log('[v0]") ||
    trimmed.includes("console.warn(`[v0]") ||
    trimmed.includes('console.warn("[v0]') ||
    trimmed.includes("console.warn('[v0]")
  ) {
    return true
  }
  return false
}

/**
 * Returns true if this is a console.error that only logs [v0] debug info
 * with no useful side effect (the error var is only used in the log).
 */
function isSoloErrorLog(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith("console.error(")) return false
  return (
    trimmed.includes("console.error(`[v0]") ||
    trimmed.includes('console.error("[v0]') ||
    trimmed.includes("console.error('[v0]")
  )
}

function findPrevNonEmpty(lines, from) {
  for (let i = from - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return i
  }
  return null
}

function findNextNonEmpty(lines, from) {
  for (let i = from + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "") return i
  }
  return null
}

let filesModified = 0
let linesRemoved = 0

function processFile(filePath) {
  const original = readFileSync(filePath, "utf8")
  const lines = original.split("\n")
  const result = []
  let modified = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Remove standalone console.log/warn [v0] debug lines
    if (isDebugLogLine(line)) {
      modified = true
      linesRemoved++
      continue
    }

    // Remove console.error [v0] lines that are the SOLE statement in a catch block
    if (isSoloErrorLog(line)) {
      const prevIdx = findPrevNonEmpty(lines, i)
      const nextIdx = findNextNonEmpty(lines, i)
      if (
        prevIdx !== null &&
        /\}\s*catch/.test(lines[prevIdx]) &&
        nextIdx !== null &&
        lines[nextIdx].trim().startsWith("}")
      ) {
        modified = true
        linesRemoved++
        continue
      }
    }

    result.push(line)
  }

  if (modified) {
    writeFileSync(filePath, result.join("\n"), "utf8")
    filesModified++
    console.log("  Cleaned: " + filePath.replace(ROOT + "/", ""))
  }
}

function walkDir(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stat
    try { stat = statSync(full) } catch { continue }

    if (stat.isDirectory()) {
      walkDir(full)
    } else if (stat.isFile()) {
      const ext = extname(full)
      if (ext === ".tsx" || ext === ".ts") {
        processFile(full)
      }
    }
  }
}

console.log("Scanning for [v0] debug logs to remove...\n")
walkDir(ROOT)
console.log("\nDone. Modified " + filesModified + " files, removed ~" + linesRemoved + " debug log lines.")
