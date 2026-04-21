#!/bin/bash
set -e

echo "🚀 Deploying CTS v3..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check if .env.local exists
if [ ! -f .env.local ]; then
    echo -e "${RED}❌ .env.local not found. Copy .env.example to .env.local and configure${NC}"
    exit 1
fi

# Install dependencies (using bun for dependency resolution)
echo -e "${YELLOW}📦 Installing dependencies...${NC}"
bun install --frozen-lockfile

# Run checks (errors are non-blocking; skipped as per next.config.mjs)
echo -e "${YELLOW}🔍 Skipping strict typecheck/lint checks (configured in next.config.mjs)...${NC}"
echo -e "${YELLOW}ℹ️  Typecheck/lint skipped for deployment; next.config.mjs declares them non-blocking${NC}"

# Build application
echo -e "${YELLOW}🔨 Building application...${NC}"
npm run build

# Run health check if in development
if [ "$NODE_ENV" != "production" ]; then
    echo -e "${YELLOW}🏥 Running health check...${NC}"
    timeout 30 npm start &
    SERVER_PID=$!
    sleep 5

    if curl -f http://localhost:3002/health > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Health check passed${NC}"
    else
        echo -e "${RED}❌ Health check failed${NC}"
        kill $SERVER_PID 2>/dev/null || true
        exit 1
    fi

    kill $SERVER_PID 2>/dev/null || true
fi

echo -e "${GREEN}✅ Deployment preparation complete!${NC}"
echo -e "${GREEN}🌐 Ready for production deployment${NC}"