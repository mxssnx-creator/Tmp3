'use client'

import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Play, Pause, RotateCcw, Activity, Zap, Settings } from 'lucide-react'

interface TestMetrics {
  cycles: number
  indications: number
  strategies: number
  positions: number
  successRate: number
  profit: number
}

interface TestPhase {
  name: string
  status: 'pending' | 'running' | 'complete' | 'failed'
  startTime?: number
  endTime?: number
  metrics: TestMetrics
}

interface DebugConfig {
  enabled: boolean
  verbose: boolean
  logIndications: boolean
  logStrategies: boolean
  logPositions: boolean
  logMarketData: boolean
  logRedis: boolean
  logAPI: boolean
  logErrors: boolean
}

export function TestDashboard() {
  const [isRunning, setIsRunning] = useState(false)
  const [phases, setPhases] = useState<TestPhase[]>([
    {
      name: 'Prehistoric Data Loading',
      status: 'pending',
      metrics: { cycles: 0, indications: 0, strategies: 0, positions: 0, successRate: 0, profit: 0 },
    },
    {
      name: 'Indication Generation',
      status: 'pending',
      metrics: { cycles: 0, indications: 0, strategies: 0, positions: 0, successRate: 0, profit: 0 },
    },
    {
      name: 'Strategy Evaluation',
      status: 'pending',
      metrics: { cycles: 0, indications: 0, strategies: 0, positions: 0, successRate: 0, profit: 0 },
    },
    {
      name: 'Position Creation',
      status: 'pending',
      metrics: { cycles: 0, indications: 0, strategies: 0, positions: 0, successRate: 0, profit: 0 },
    },
  ])
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [debugConfig, setDebugConfig] = useState<DebugConfig>({
    enabled: false,
    verbose: false,
    logIndications: false,
    logStrategies: false,
    logPositions: false,
    logMarketData: false,
    logRedis: false,
    logAPI: false,
    logErrors: true,
  })
  const [logs, setLogs] = useState<string[]>([])

  const addLog = (message: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${message}`])
  }

  const toggleDebugMode = async () => {
    try {
      const res = await fetch(`/api/debug?action=${!debugEnabled ? 'enable' : 'disable'}`)
      const data = await res.json()
      setDebugEnabled(!debugEnabled)
      addLog(`Debug mode ${!debugEnabled ? 'enabled' : 'disabled'}`)
    } catch (error) {
      addLog(`Error toggling debug: ${error}`)
    }
  }

  const setDebugOption = async (option: string, value: boolean) => {
    try {
      const res = await fetch('/api/debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-option', option, value }),
      })
      const data = await res.json()
      setDebugConfig(data.config)
      addLog(`Debug option ${option} = ${value}`)
    } catch (error) {
      addLog(`Error setting debug option: ${error}`)
    }
  }

  const startTest = async () => {
    setIsRunning(true)
    addLog('Starting DRIFTUSDT complete progression test...')

    try {
      const res = await fetch('/api/trade-engine/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: 'default-bingx-001' }),
      })

      if (res.ok) {
        addLog('Engine started successfully')
        monitorProgress()
      } else {
        addLog('Engine already running or error occurred')
      }
    } catch (error) {
      addLog(`Error starting engine: ${error}`)
      setIsRunning(false)
    }
  }

  const monitorProgress = async () => {
    let testTime = 0
    const testInterval = setInterval(async () => {
      testTime += 2000

      try {
        const res = await fetch('/api/connections/progression/default-bingx-001')
        if (!res.ok) return

        const data = await res.json()
        const state = data.state || {}

        const metrics: TestMetrics = {
          cycles: state.cyclesCompleted || 0,
          indications: state.indicationEvaluatedDirection || 0,
          strategies: state.strategyEvaluatedReal || 0,
          positions: state.totalPositionsOpened || 0,
          successRate: state.cycleSuccessRate || 0,
          profit: state.totalProfit || 0,
        }

        setPhases(prev =>
          prev.map((phase, idx) => {
            let status = phase.status
            if (idx === 0 && metrics.cycles > 0) status = 'complete'
            else if (idx === 1 && metrics.indications > 0) status = 'complete'
            else if (idx === 2 && metrics.strategies > 100) status = 'complete'
            else if (idx === 3 && metrics.positions > 0) status = 'complete'

            return { ...phase, metrics, status }
          })
        )

        if (testTime >= 60000) {
          clearInterval(testInterval)
          setIsRunning(false)
          addLog('Test complete!')
        }
      } catch (error) {
        addLog(`Monitor error: ${error}`)
      }
    }, 2000)
  }

  const resetTest = () => {
    setPhases(prev =>
      prev.map(phase => ({
        ...phase,
        status: 'pending',
        metrics: { cycles: 0, indications: 0, strategies: 0, positions: 0, successRate: 0, profit: 0 },
      }))
    )
    setLogs([])
    addLog('Test reset')
  }

  return (
    <div className='space-y-4 p-4'>
      <Card className='p-4 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950 dark:to-indigo-950'>
        <div className='flex items-center justify-between mb-4'>
          <div className='flex items-center gap-2'>
            <Activity className='w-5 h-5 text-blue-600' />
            <h2 className='text-lg font-bold'>Autotest & Debug Dashboard</h2>
            <Badge variant={isRunning ? 'default' : 'secondary'}>
              {isRunning ? 'Running' : 'Idle'}
            </Badge>
          </div>

          <div className='flex gap-2'>
            <Button size='sm' onClick={startTest} disabled={isRunning} className='gap-2'>
              <Play className='w-4 h-4' />
              Start Test
            </Button>
            <Button size='sm' variant='outline' onClick={resetTest} className='gap-2'>
              <RotateCcw className='w-4 h-4' />
              Reset
            </Button>
            <Button
              size='sm'
              variant={debugEnabled ? 'default' : 'outline'}
              onClick={toggleDebugMode}
              className='gap-2'
            >
              <Settings className='w-4 h-4' />
              Debug {debugEnabled ? 'ON' : 'OFF'}
            </Button>
          </div>
        </div>

        <Tabs defaultValue='phases' className='w-full'>
          <TabsList className='grid w-full grid-cols-3'>
            <TabsTrigger value='phases'>Test Phases</TabsTrigger>
            <TabsTrigger value='debug'>Debug Options</TabsTrigger>
            <TabsTrigger value='logs'>Logs</TabsTrigger>
          </TabsList>

          <TabsContent value='phases' className='mt-4 space-y-2'>
            {phases.map((phase, idx) => (
              <Card key={idx} className='p-3 bg-white dark:bg-slate-900'>
                <div className='flex items-center justify-between mb-2'>
                  <div className='flex items-center gap-2'>
                    <div className={`w-2 h-2 rounded-full ${
                      phase.status === 'complete' ? 'bg-green-500' :
                      phase.status === 'running' ? 'bg-blue-500' :
                      phase.status === 'failed' ? 'bg-red-500' :
                      'bg-gray-300'
                    }`} />
                    <span className='font-medium text-sm'>{phase.name}</span>
                    <Badge variant={phase.status === 'complete' ? 'default' : 'secondary'} className='text-xs'>
                      {phase.status}
                    </Badge>
                  </div>
                </div>
                <div className='grid grid-cols-3 gap-2 text-xs text-muted-foreground'>
                  <div>Cycles: <span className='font-bold text-foreground'>{phase.metrics.cycles}</span></div>
                  <div>Indications: <span className='font-bold text-foreground'>{phase.metrics.indications}</span></div>
                  <div>Strategies: <span className='font-bold text-foreground'>{phase.metrics.strategies}</span></div>
                </div>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value='debug' className='mt-4 space-y-3'>
            {Object.entries(debugConfig).map(([key, value]) => (
              <div key={key} className='flex items-center justify-between p-2 bg-slate-100 dark:bg-slate-800 rounded'>
                <span className='text-sm font-medium capitalize'>{key.replace(/([A-Z])/g, ' $1')}</span>
                <Button
                  size='sm'
                  variant={value ? 'default' : 'outline'}
                  onClick={() => setDebugOption(key, !value)}
                  className='w-20'
                >
                  {value ? 'ON' : 'OFF'}
                </Button>
              </div>
            ))}
          </TabsContent>

          <TabsContent value='logs' className='mt-4'>
            <ScrollArea className='h-64 border rounded p-3 bg-slate-50 dark:bg-slate-900'>
              <div className='space-y-1'>
                {logs.length === 0 ? (
                  <p className='text-sm text-muted-foreground'>No logs yet...</p>
                ) : (
                  logs.map((log, idx) => (
                    <div key={idx} className='text-xs font-mono text-muted-foreground'>
                      {log}
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  )
}
