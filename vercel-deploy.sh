#!/bin/bash
set -e

echo "🚀 Deploying CTS v3 to Vercel..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check if Vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo -e "${YELLOW}Installing Vercel CLI...${NC}"
    npm i -g vercel
fi

# Login to Vercel (if not already logged in)
echo -e "${YELLOW}Checking Vercel authentication...${NC}"
if ! vercel whoami &> /dev/null; then
    echo -e "${YELLOW}Please login to Vercel:${NC}"
    vercel login
fi

# Link project (if not already linked)
if [ ! -f .vercel/project.json ]; then
    echo -e "${YELLOW}Linking project to Vercel...${NC}"
    vercel link
fi

# Add environment variables (if not already set)
echo -e "${YELLOW}Setting up environment variables...${NC}"

# Check if NEXT_PUBLIC_APP_URL is set
if ! vercel env ls | grep -q "NEXT_PUBLIC_APP_URL"; then
    echo -e "${YELLOW}Adding NEXT_PUBLIC_APP_URL...${NC}"
    vercel env add NEXT_PUBLIC_APP_URL
else
    echo -e "${GREEN}NEXT_PUBLIC_APP_URL already set${NC}"
fi

# Check if KV_REST_API_URL is set
if ! vercel env ls | grep -q "KV_REST_API_URL"; then
    echo -e "${YELLOW}Adding KV_REST_API_URL...${NC}"
    vercel env add KV_REST_API_URL
else
    echo -e "${GREEN}KV_REST_API_URL already set${NC}"
fi

# Check if KV_REST_API_TOKEN is set
if ! vercel env ls | grep -q "KV_REST_API_TOKEN"; then
    echo -e "${YELLOW}Adding KV_REST_API_TOKEN...${NC}"
    vercel env add KV_REST_API_TOKEN
else
    echo -e "${GREEN}KV_REST_API_TOKEN already set${NC}"
fi

# Check if JWT_SECRET is set
if ! vercel env ls | grep -q "JWT_SECRET"; then
    echo -e "${YELLOW}Adding JWT_SECRET...${NC}"
    vercel env add JWT_SECRET
else
    echo -e "${GREEN}JWT_SECRET already set${NC}"
fi

# Run local checks before deployment
echo -e "${YELLOW}Running pre-deployment checks...${NC}"
npm run typecheck
npm run lint
npm run build

# Deploy to production
echo -e "${YELLOW}Deploying to Vercel production...${NC}"
vercel --prod

echo -e "${GREEN}✅ Deployment to Vercel complete!${NC}"
echo -e "${GREEN}🌐 Check your Vercel dashboard for the deployment URL${NC}"