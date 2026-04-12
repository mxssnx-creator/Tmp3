const fs = require('fs')
const path = require('path')

console.log('=== CWD ===')
console.log(process.cwd())

console.log('\n=== __dirname ===')
console.log(__dirname)

const candidates = [
  '/vercel/share/v0-project',
  '/app',
  '/workspace',
  process.cwd(),
  path.join(process.cwd(), '..'),
  path.join(process.cwd(), '../..'),
  path.join(__dirname, '..'),
]

console.log('\n=== CANDIDATE ROOTS ===')
for (const c of candidates) {
  try {
    const items = fs.readdirSync(c)
    const hasLib = items.includes('lib')
    const hasApp = items.includes('app')
    const hasPkg = items.includes('package.json')
    console.log(`  ${c}: lib=${hasLib} app=${hasApp} pkg=${hasPkg}  [${items.slice(0,8).join(', ')}]`)
  } catch (e) {
    console.log(`  ${c}: ERROR - ${e.code}`)
  }
}
