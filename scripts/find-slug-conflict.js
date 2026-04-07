import { readdirSync, statSync } from "fs"
import { join } from "path"

const root = "/vercel/share/v0-project/app/api"

function walk(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry)
    try {
      const stat = statSync(full)
      if (stat.isDirectory()) {
        if (entry.startsWith("[")) {
          console.log("DYNAMIC:", full.replace(root, ""), "  slug=", entry)
        }
        walk(full)
      }
    } catch {}
  }
}

walk(root)
console.log("Done scanning.")
