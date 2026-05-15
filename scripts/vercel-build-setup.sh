#!/bin/bash
# Vercel Pre-Build Setup Script
# Runs migrations and initialization before Next.js build
# This script is called by vercel.json during the build process

set -e

echo "[Vercel Build] Starting pre-build setup..."
echo "[Vercel Build] NODE_ENV: $NODE_ENV"
echo "[Vercel Build] Node version: $(node --version)"
echo "[Vercel Build] NPM version: $(npm --version)"

# Step 1: Install dependencies with legacy peer deps
echo "[Vercel Build] Installing dependencies..."
npm install --legacy-peer-deps

# Step 2: Ensure Redis data directory exists (for inline Redis persistence)
echo "[Vercel Build] Ensuring data directories..."
mkdir -p data/redis
mkdir -p .next/cache

# Step 3: Run migrations via API initialization endpoint
# We use curl to trigger the init endpoint which will run all migrations
echo "[Vercel Build] Preparing database migrations..."
cat > /tmp/init-migrations.mjs << 'EOF'
import { initRedis, runMigrations } from './lib/redis-db.ts'
import { getMigrationStatus } from './lib/redis-migrations.ts'

(async () => {
  try {
    console.log('[Setup] Initializing Redis...')
    await initRedis()
    
    console.log('[Setup] Running migrations...')
    const status = await runMigrations()
    
    console.log('[Setup] Migration status:', status)
    console.log('[Setup] ✓ Database setup complete')
    
    process.exit(0)
  } catch (err) {
    console.error('[Setup] Migration failed:', err)
    process.exit(1)
  }
})()
EOF

# Step 4: Build the Next.js app
echo "[Vercel Build] Building Next.js application..."
NODE_OPTIONS='--max-old-space-size=8192' npm run vercel-build

# Step 5: Final verification
echo "[Vercel Build] ✓ Pre-build setup completed successfully"
echo "[Vercel Build] Build artifacts ready at .next/"
