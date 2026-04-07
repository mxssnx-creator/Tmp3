/**
 * Comprehensive System Progression Test
 * Validates the complete progression system from API to UI components
 */

import fetch from 'node-fetch'

const BASE_URL = 'http://localhost:3002'

interface TestResult {
  name: string
  passed: boolean
  error?: string
  details?: any
}

const results: TestResult[] = []

async function runTest(name: string, testFn: () => Promise<void>) {
  try {
    await testFn()
    results.push({ name, passed: true })
    console.log(`✓ ${name}`)
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    })
    console.error(`✗ ${name}:`, error)
  }
}

async function testProgressionAPI() {
  await runTest('Progression API - GET /api/trade-engine/progression', async () => {
    const response = await fetch(`${BASE_URL}/api/trade-engine/progression`)
    if (!response.ok) throw new Error(`Status ${response.status}`)
    const data = (await response.json()) as any
    if (!data.connections) throw new Error('No connections in response')
    console.log(`  Found ${data.connections.length} connections`)
  })
}

async function testSystemMonitoring() {
  await runTest('System Monitoring - GET /api/system/monitoring', async () => {
    const response = await fetch(`${BASE_URL}/api/system/monitoring`)
    if (!response.ok) throw new Error(`Status ${response.status}`)
    const data = (await response.json()) as any
    if (!data.cpu) throw new Error('Missing CPU metric')
    console.log(`  CPU: ${data.cpu}%, Memory: ${data.memory}%`)
  })
}

async function testMonitoringStats() {
  await runTest('Monitoring Stats - GET /api/monitoring/stats', async () => {
    const response = await fetch(`${BASE_URL}/api/monitoring/stats`)
    if (!response.ok) throw new Error(`Status ${response.status}`)
    const data = (await response.json()) as any
    if (!data.statistics) throw new Error('Missing statistics')
    console.log(`  Statistics loaded successfully`)
  })
}

async function testEngineStatus() {
  await runTest('Engine Status - GET /api/engine/system-status', async () => {
    const response = await fetch(`${BASE_URL}/api/engine/system-status`)
    if (!response.ok) throw new Error(`Status ${response.status}`)
    const data = (await response.json()) as any
    if (!data.status) throw new Error('Missing status')
    console.log(`  Engine status: ${data.status}`)
  })
}

async function testHealthLiveness() {
  await runTest('Health Liveness - GET /api/health/liveness', async () => {
    const response = await fetch(`${BASE_URL}/api/health/liveness`)
    if (!response.ok) throw new Error(`Status ${response.status}`)
    const data = (await response.json()) as any
    if (data.status !== 'ok') throw new Error('Not healthy')
    console.log(`  Liveness: OK`)
  })
}

async function testHealthReadiness() {
  await runTest('Health Readiness - GET /api/health/readiness', async () => {
    const response = await fetch(`${BASE_URL}/api/health/readiness`)
    if (!response.ok) throw new Error(`Status ${response.status}`)
    const data = (await response.json()) as any
    if (!data.ready) throw new Error('Not ready')
    console.log(`  Readiness: OK`)
  })
}

async function runAllTests() {
  console.log('🚀 Starting Comprehensive Progression System Tests\n')
  console.log('Testing API Endpoints...\n')

  await testProgressionAPI()
  await testSystemMonitoring()
  await testMonitoringStats()
  await testEngineStatus()
  await testHealthLiveness()
  await testHealthReadiness()

  console.log('\n' + '='.repeat(60))
  console.log('TEST RESULTS SUMMARY')
  console.log('='.repeat(60) + '\n')

  const passed = results.filter((r) => r.passed).length
  const total = results.length

  results.forEach((r) => {
    const icon = r.passed ? '✓' : '✗'
    console.log(`${icon} ${r.name}`)
    if (r.error) console.log(`  Error: ${r.error}`)
  })

  console.log('\n' + '='.repeat(60))
  console.log(`TOTAL: ${passed}/${total} tests passed`)
  console.log('='.repeat(60) + '\n')

  if (passed === total) {
    console.log('✅ ALL TESTS PASSED - System is fully operational!\n')
  } else {
    console.log(`⚠️  ${total - passed} test(s) failed - Please review errors above\n`)
  }

  process.exit(passed === total ? 0 : 1)
}

// Run tests
runAllTests().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
