#!/bin/bash

# Trading System Complete Health Check
# Date: 2026-04-06
# Purpose: Verify all critical systems are operational

echo "==============================================="
echo "Trading System - Complete Health Check"
echo "==============================================="
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test count
TESTS_PASSED=0
TESTS_FAILED=0

# Function to test endpoint
test_endpoint() {
  local url=$1
  local name=$2
  
  echo -n "Testing $name... "
  
  if curl -sf http://localhost:3002$url > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}"
    ((TESTS_PASSED++))
  else
    echo -e "${RED}✗ FAIL${NC}"
    ((TESTS_FAILED++))
  fi
}

# Function to check file
check_file() {
  local file=$1
  local name=$2
  
  echo -n "Checking $name... "
  
  if [ -f "$file" ]; then
    echo -e "${GREEN}✓ EXISTS${NC}"
    ((TESTS_PASSED++))
  else
    echo -e "${RED}✗ MISSING${NC}"
    ((TESTS_FAILED++))
  fi
}

echo "Frontend Build & Deployment"
echo "---"
check_file "package.json" "package.json"
check_file "next.config.mjs" "next.config.mjs"
check_file "tsconfig.json" "tsconfig.json"
echo ""

echo "Key Components"
echo "---"
check_file "components/dashboard/dashboard.tsx" "Main Dashboard"
check_file "components/dashboard/statistics-overview-v2.tsx" "Statistics Component"
check_file "components/dashboard/system-monitoring-panel.tsx" "Monitoring Panel"
check_file "components/dashboard/exchange-statistics.tsx" "Exchange Stats"
echo ""

echo "API Endpoint Health Check"
echo "---"
test_endpoint "/api/health/liveness" "Health Liveness"
test_endpoint "/api/monitoring/stats" "Monitoring Stats"
test_endpoint "/api/system/monitoring" "System Monitoring"
test_endpoint "/main" "Dashboard Page"
test_endpoint "/monitoring" "Monitoring Page"
echo ""

echo "Critical Libraries"
echo "---"
echo -n "Checking React... "
if grep -q '"react":' package.json; then
  echo -e "${GREEN}✓ INSTALLED${NC}"
  ((TESTS_PASSED++))
else
  echo -e "${RED}✗ MISSING${NC}"
  ((TESTS_FAILED++))
fi

echo -n "Checking Next.js... "
if grep -q '"next":' package.json; then
  echo -e "${GREEN}✓ INSTALLED${NC}"
  ((TESTS_PASSED++))
else
  echo -e "${RED}✗ MISSING${NC}"
  ((TESTS_FAILED++))
fi

echo -n "Checking Tailwind CSS... "
if grep -q '"tailwindcss":' package.json; then
  echo -e "${GREEN}✓ INSTALLED${NC}"
  ((TESTS_PASSED++))
else
  echo -e "${RED}✗ MISSING${NC}"
  ((TESTS_FAILED++))
fi

echo -n "Checking Redis Support... "
if grep -q "redis" package.json; then
  echo -e "${GREEN}✓ CONFIGURED${NC}"
  ((TESTS_PASSED++))
else
  echo -e "${YELLOW}⚠ NOT IN PACKAGE.JSON${NC}"
fi

echo ""
echo "Documentation"
echo "---"
check_file "SYSTEM_AUDIT_REPORT.md" "System Audit Report"
check_file "FIXES_APPLIED.md" "Fixes Documentation"
echo ""

echo "==============================================="
echo "Test Results Summary"
echo "==============================================="
echo -e "Passed: ${GREEN}${TESTS_PASSED}${NC}"
echo -e "Failed: ${RED}${TESTS_FAILED}${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ All critical systems operational${NC}"
  echo "System Status: PRODUCTION READY"
  exit 0
else
  echo -e "${RED}✗ Some tests failed${NC}"
  echo "System Status: REVIEW REQUIRED"
  exit 1
fi
