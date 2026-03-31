#!/bin/bash
echo "🧹 Clearing all Next.js and Turbopack caches..."
rm -rf .next
rm -rf .turbopack
rm -rf node_modules/.cache
rm -rf .vercel
rm -rf .turbo
find . -name "*.tsbuildinfo" -type f -delete
echo "✅ Cache cleared successfully!"
echo ""
echo "Run 'npm run build' to build with fresh cache"
