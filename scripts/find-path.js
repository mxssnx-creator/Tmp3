import { readdirSync, existsSync } from "fs"
import { resolve } from "path"

console.log("cwd:", process.cwd())
console.log("__dirname equivalent:", import.meta.url)

const candidates = [
  "/vercel/share/v0-project",
  "/app",
  "/home/user",
  process.cwd(),
  resolve(process.cwd(), ".."),
  resolve(process.cwd(), "../.."),
]

for (const c of candidates) {
  if (existsSync(c)) {
    try {
      const entries = readdirSync(c)
      console.log(`\n${c}: [${entries.slice(0, 10).join(", ")}]`)
      if (existsSync(`${c}/lib/redis-db.ts`)) {
        console.log(`  ✓ Found redis-db.ts here!`)
      }
    } catch (e) {
      console.log(`${c}: <permission error>`)
    }
  }
}
