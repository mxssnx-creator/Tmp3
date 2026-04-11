/**
 * Removes all console.[log|warn]("[v0] ...") debug statements from .tsx and .ts source files.
 * Keeps console.error("[v0] ...") statements at a functional level where the error variable
 * is being passed — those become bare `catch` clauses.
 *
 * Strategy:
 *  1. For lines that are ONLY a console.log/warn with [v0], remove the line entirely.
 *  2. For catch blocks that ONLY contain a console.error and nothing else meaningful,
 *     replace the entire catch body with an empty or comment-only body.
 *  3. Leave console.error lines that feed into real error state (setError, throw, etc).
 *
 * This script uses regex on a line-by-line basis for safety.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs"
import { join, extname } from "path"

const ROOT = "/vercel/share/v0-project"

// Directories to skip entirely
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "scripts",
  "backup",
  "docs",
  "public",
])

// Lines that are solely a console.log or console.warn with [v0] prefix — remove entirely.
// Matches backtick, single-quote, and double-quote string starts.
const REMOVE_LINE_PATTERNS = [
  /^\s*console\.log\([\`'"]\[v0\]/,
  /^\s*console\.warn\([\`'"]\[v0\]/,
]

// console.error with [v0] where the error variable is ONLY used in the log line
const SOLO_ERROR_LOG = /^\s*console\.error\([\`'"]\[v0\][^)]*,\s*(error|err|e)\s*\)\s*$/
const SOLO_ERROR_LOG_NO_VAR = /^\s*console\.error\([\`'"]\[v0\][^)]*\)\s*$/

let filesModified = 0
let linesRemoved = 0

function processFile(filePath) {
  const original = readFileSync(filePath, "utf8")
  const lines = original.split("\n")
  const result = []
  let modified = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Remove standalone console.log/warn [v0] lines
    if (REMOVE_LINE_PATTERNS.some((p) => p.test(line))) {
      modified = true
      linesRemoved++
      continue
    }

    // For console.error lines that pass only the error var (no other purpose):
    // Only remove if the catch clause around it is simple (next line closes the block)
    if (SOLO_ERROR_LOG.test(line) || SOLO_ERROR_LOG_NO_VAR.test(line)) {
      // Check if this is the only statement in a catch block:
      // previous non-empty line is "} catch ... {" or "} catch {"
      // and next non-empty line is "}"
      const prevLine = findPrevNonEmpty(lines, i)
      const nextLine = findNextNonEmpty(lines, i)
      if (
        prevLine !== null &&
        /\}\s*catch\s*/.test(lines[prevLine]) &&
        nextLine !== null &&
        /^\s*\}/.test(lines[nextLine])
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
    console.log(`  Cleaned: ${filePath.replace(ROOT + "/", "")}`)
  }
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

function walkDir(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
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
console.log(`\nDone. Modified ${filesModified} files, removed ~${linesRemoved} debug log lines.`)
