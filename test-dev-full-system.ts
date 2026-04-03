#!/usr/bin/env bun

import fs from 'fs/promises';
import { setTimeout } from 'timers/promises';

const BASE_URL = 'http://localhost:3002';
const RESULTS: any = {
  startTime: new Date().toISOString(),
  prehistoricPhase: {},
  realtimePhase: {},
  summary: {}
};

async function fetchApi(path: string, options?: RequestInit) {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Cache-Control': 'no-cache' },
      ...options
    });
    return await res.json();
  } catch (err) {
    return { error: String(err) };
  }
}

async function logStep(name: string, data?: any) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ ${name}`);
  if (data) {
    console.dir(data, { depth: null });
  }
}

async function runTest() {
  console.log("\n📊 DEV FULL SYSTEM MONITORING TEST\n");
  console.log(`Target: ${BASE_URL}`);
  console.log(`Started: ${new Date().toLocaleString()}\n`);

  // 1. Initial Health Check
  await logStep("1. Checking system health");
  const health = await fetchApi('/api/health');
  console.log(`Health status: ${health.ok ? '✅ OK' : '❌ FAIL'}`);

  // 2. Start quickstart prehistoric processing
  await logStep("2. Starting quickstart engine initialization");
  const quickstartInit = await fetchApi('/api/trade-engine/quick-start', { method: 'POST' });
  console.log(`Quickstart initialized: ${quickstartInit.success ? '✅ OK' : '⚠️ Warning'}`);

  // 2.5 Explicitly start trade engine
  await logStep("2.5 Starting trade engine service");
  const engineStart = await fetchApi('/api/trade-engine/start', { method: 'POST' });
  console.log(`Engine start status: ${engineStart.success ? '✅ Running' : '⚠️ Already running'}`);
  await setTimeout(8000);

  // 3. Monitor Prehistoric Data Phase
  await logStep("3. Monitoring Prehistoric Data Processing (10s intervals for 2min)");

  for (let i = 0; i < 12; i++) {
    const mon = await fetchApi('/api/system/monitoring');
    const connLog = await fetchApi('/api/settings/connections/test/log');

    RESULTS.prehistoricPhase[`check_${i+1}`] = {
      timestamp: new Date().toISOString(),
      cpu: mon.cpu,
      memory: mon.memory,
      prehistoric: connLog.summary?.prehistoricData,
      cycles: connLog.summary?.enginePerformance?.cyclesCompleted
    };

    console.log(`  [${i+1}/12] CPU: ${mon.cpu}% | MEM: ${mon.memory}% | Cycles: ${connLog.summary?.enginePerformance?.cyclesCompleted || 0} | Symbols: ${connLog.summary?.prehistoricData?.symbolsProcessed || 0}`);

    if (connLog.summary?.prehistoricData?.phaseActive === false && connLog.summary?.prehistoricData?.cyclesCompleted > 0) {
      console.log(`  ✅ Prehistoric processing completed at check ${i+1}`);
      break;
    }
    await setTimeout(10000);
  }

  // 4. Prehistoric Phase Completed - Full System Snapshot
  await logStep("4. Prehistoric Phase Completed - System Snapshot");
  const finalPrehistoric = await fetchApi('/api/system/monitoring');
  const finalConnLog = await fetchApi('/api/settings/connections/test/log');

  RESULTS.prehistoricPhase.final = {
    systemMetrics: finalPrehistoric,
    connectionSummary: finalConnLog.summary,
    databaseStatus: await fetchApi('/api/health/database')
  };

  console.log("📌 Prehistoric Phase Results:");
  console.log(`   Cycles Completed: ${finalConnLog.summary?.enginePerformance?.cyclesCompleted}`);
  console.log(`   Candles Processed: ${finalConnLog.summary?.prehistoricData?.candlesProcessed}`);
  console.log(`   Symbols Loaded: ${finalConnLog.summary?.prehistoricData?.symbolsProcessed}`);
  console.log(`   Success Rate: ${finalConnLog.summary?.enginePerformance?.cycleSuccessRate?.toFixed(1)}%`);
  console.log(`   Average Cycle Time: ${finalConnLog.summary?.enginePerformance?.cycleTimeMs}ms`);

  // 5. Realtime Monitoring Phase (60 seconds)
  await logStep("5. Realtime Processing Phase (1 minute monitoring)");

  const realtimeStart = Date.now();
  let lastCycleCount = finalConnLog.summary?.enginePerformance?.cyclesCompleted || 0;

  for (let i = 0; i < 6; i++) {
    await setTimeout(10000);

    const mon = await fetchApi('/api/system/monitoring');
    const connLog = await fetchApi('/api/settings/connections/test/log');
    const mainStats = await fetchApi('/api/main/system-stats-v3');

    const currentCycles = connLog.summary?.enginePerformance?.cyclesCompleted || lastCycleCount;
    const cyclesPerMinute = ((currentCycles - lastCycleCount) / ((Date.now() - realtimeStart) / 60000)).toFixed(1);

    RESULTS.realtimePhase[`check_${i+1}`] = {
      timestamp: new Date().toISOString(),
      cpu: mon.cpu,
      memory: mon.memory,
      cyclesCompleted: currentCycles,
      indicationsGenerated: connLog.summary?.indicationsCounts,
      strategiesEvaluated: connLog.summary?.strategyCounts,
      positions: connLog.summary?.enginePerformance?.totalTrades
    };

    console.log(`  [${(i+1)*10}s] CPU: ${mon.cpu}% | MEM: ${mon.memory}% | Cycles: ${currentCycles} | Rate: ${cyclesPerMinute}/min | Indications: ${Object.values(connLog.summary?.indicationsCounts || {}).reduce((a: number, b: number) => a + b, 0)}`);
    lastCycleCount = currentCycles;
  }

  // 6. Full Final Report
  await logStep("6. FINAL FULL SYSTEM REPORT");

  const finalMonitor = await fetchApi('/api/system/monitoring');
  const finalConn = await fetchApi('/api/settings/connections/test/log');
  const engineStatus = await fetchApi('/api/trade-engine/status');
  const metrics = await fetchApi('/api/metrics');
  const dbStatus = await fetchApi('/api/health/database');

  RESULTS.summary = {
    testDuration: `${((Date.now() - new Date(RESULTS.startTime).getTime()) / 1000 / 60).toFixed(1)} minutes`,
    totalCycles: finalConn.summary?.enginePerformance?.cyclesCompleted,
    totalIndications: Object.values(finalConn.summary?.indicationsCounts || {}).reduce((a: number, b: number) => a + b, 0),
    totalStrategiesEvaluated: Object.values(finalConn.summary?.strategyCounts || {}).reduce((a: number, b: any) => a + b.evaluated, 0),
    cycleSuccessRate: finalConn.summary?.enginePerformance?.cycleSuccessRate,
    averageCycleTime: finalConn.summary?.enginePerformance?.cycleTimeMs,
    averageCpu: finalMonitor.cpu,
    averageMemory: finalMonitor.memory,
    databaseSize: finalMonitor.database.size,
    databaseKeys: finalMonitor.database.keys
  };

  console.log("\n📋 FINAL RESULTS:");
  console.table(RESULTS.summary);

  console.log("\n✅ TEST COMPLETED SUCCESSFULLY");
  console.log(`Test report written to dev-system-test-results.json`);

  await fs.writeFile('dev-system-test-results.json', JSON.stringify(RESULTS, null, 2));
}

runTest().catch(err => {
  console.error("\n❌ TEST FAILED:", err);
  process.exit(1);
});
