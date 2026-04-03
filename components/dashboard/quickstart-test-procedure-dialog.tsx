"use client"

import { useState, useEffect, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AlertCircle, CheckCircle2, Clock, Play, RefreshCw, Terminal, Zap } from "lucide-react"

interface TestStep {
  id: string
  name: string
  description: string
  endpoint: string
  status: "pending" | "running" | "success" | "warning" | "error"
  duration?: number
  result?: any
  error?: string
}

interface TestReport {
  startedAt: Date
  completedAt?: Date
  totalSteps: number
  passedSteps: number
  failedSteps: number
  overallStatus: "pending" | "running" | "success" | "partial" | "failed"
}

const TEST_STEPS: TestStep[] = [
  {
    id: "health",
    name: "System Health Check",
    description: "Verify base server health and endpoints are responding",
    endpoint: "/api/health",
    status: "pending"
  },
  {
    id: "init",
    name: "System Initialization",
    description: "Initialize base system components and configuration",
    endpoint: "/api/init",
    status: "pending"
  },
  {
    id: "migrations",
    name: "Database Migrations",
    description: "Validate all database schema migrations are applied",
    endpoint: "/api/install/database/migrate",
    status: "pending"
  },
  {
    id: "coordinator",
    name: "Start Coordinator",
    description: "Start global trade engine coordinator service",
    endpoint: "/api/trade-engine/start",
    status: "pending"
  },
  {
    id: "quickstart",
    name: "Run Quickstart Procedure",
    description: "Execute full quickstart workflow with BTCUSDT symbol",
    endpoint: "/api/trade-engine/quick-start",
    status: "pending"
  },
  {
    id: "verify_engine",
    name: "Engine Verification",
    description: "Verify engine state, connections, and processing status",
    endpoint: "/api/engine/verify",
    status: "pending"
  },
  {
    id: "monitoring",
    name: "System Monitoring Check",
    description: "Validate CPU, memory, database and module metrics",
    endpoint: "/api/system/monitoring",
    status: "pending"
  },
  {
    id: "prehistoric_progress",
    name: "Prehistoric Progress Check",
    description: "Monitor prehistoric data loading and processing status",
    endpoint: "/api/trade-engine/status",
    status: "pending"
  },
  {
    id: "indications_active",
    name: "Indications Generation Check",
    description: "Verify realtime indications are being calculated",
    endpoint: "/api/main/system-stats-v3",
    status: "pending"
  },
  {
    id: "strategies_active",
    name: "Strategies Evaluation Check",
    description: "Verify strategies are running and evaluating",
    endpoint: "/api/strategies/overview",
    status: "pending"
  },
  {
    id: "final_health",
    name: "Final System Health",
    description: "Final health verification with all components running",
    endpoint: "/api/health/readiness",
    status: "pending"
  }
]

export function QuickstartTestProcedureDialog() {
  const [open, setOpen] = useState(false)
  const [steps, setSteps] = useState<TestStep[]>(TEST_STEPS)
  const [report, setReport] = useState<TestReport | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [currentStepIndex, setCurrentStepIndex] = useState(-1)

  const resetTest = useCallback(() => {
    setSteps(TEST_STEPS.map(s => ({ ...s, status: "pending", result: undefined, error: undefined, duration: undefined })))
    setReport(null)
    setCurrentStepIndex(-1)
    setIsRunning(false)
  }, [])

  const runStep = useCallback(async (step: TestStep, index: number): Promise<TestStep> => {
    const startTime = Date.now()
    const updated = { ...step, status: "running" as const }

    setSteps(prev => {
      const next = [...prev]
      next[index] = updated
      return next
    })

    try {
      const res = await fetch(step.endpoint, {
        method: step.endpoint.includes("quick-start") || step.endpoint.includes("start") || step.endpoint.includes("migrate")
          ? "POST" : "GET",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(25000)
      })

      const data = await res.json().catch(() => ({}))
      const duration = Date.now() - startTime

      if (res.ok || data.success) {
        return { ...step, status: "success", result: data, duration }
      } else {
        return { ...step, status: "warning", result: data, duration, error: data.error || `HTTP ${res.status}` }
      }
    } catch (err) {
      const duration = Date.now() - startTime
      return { ...step, status: "error", duration, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  const runFullTest = useCallback(async () => {
    setIsRunning(true)
    setReport({
      startedAt: new Date(),
      totalSteps: TEST_STEPS.length,
      passedSteps: 0,
      failedSteps: 0,
      overallStatus: "running"
    })

    for (let i = 0; i < TEST_STEPS.length; i++) {
      setCurrentStepIndex(i)
      const result = await runStep(TEST_STEPS[i], i)

      setSteps(prev => {
        const next = [...prev]
        next[i] = result
        return next
      })

      setReport(prev => prev ? {
        ...prev,
        passedSteps: prev.passedSteps + (result.status === "success" ? 1 : 0),
        failedSteps: prev.failedSteps + (result.status === "error" ? 1 : 0)
      } : prev)

      // Small delay between steps for state propagation
      await new Promise(resolve => setTimeout(resolve, 800))
    }

    setReport(prev => prev ? {
      ...prev,
      completedAt: new Date(),
      overallStatus: prev.failedSteps > 0 ? (prev.passedSteps > 0 ? "partial" : "failed") : "success"
    } : prev)

    setIsRunning(false)
    setCurrentStepIndex(-1)
  }, [runStep])

  const getStatusIcon = (status: TestStep["status"]) => {
    switch (status) {
      case "running": return <Clock className="w-4 h-4 animate-spin text-blue-500" />
      case "success": return <CheckCircle2 className="w-4 h-4 text-green-500" />
      case "warning": return <AlertCircle className="w-4 h-4 text-yellow-500" />
      case "error": return <AlertCircle className="w-4 h-4 text-red-500" />
      default: return <div className="w-4 h-4 rounded-full border-2 border-gray-300" />
    }
  }

  const getOverallProgress = () => {
    if (!report) return 0
    const completed = steps.filter(s => s.status !== "pending").length
    return (completed / TEST_STEPS.length) * 100
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className="gap-1 text-xs">
          <Terminal className="w-3.5 h-3.5" />
          Test Procedure
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" />
            Quickstart System Test Procedure
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Progress Bar */}
          {isRunning && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Running test procedure...</span>
                <span>{Math.round(getOverallProgress())}%</span>
              </div>
              <Progress value={getOverallProgress()} className="h-2" />
            </div>
          )}

          {/* Summary Badge */}
          {report && (
            <div className="flex items-center gap-2">
              <Badge variant={
                report.overallStatus === "success" ? "default" :
                report.overallStatus === "partial" ? "secondary" :
                report.overallStatus === "failed" ? "destructive" : "outline"
              }>
                Status: {report.overallStatus.toUpperCase()}
              </Badge>
              <Badge variant="outline">
                ✅ {report.passedSteps} / ❌ {report.failedSteps} / {TEST_STEPS.length}
              </Badge>
              {report.completedAt && (
                <Badge variant="outline">
                  Duration: {((report.completedAt.getTime() - report.startedAt.getTime()) / 1000).toFixed(1)}s
                </Badge>
              )}
            </div>
          )}

          {/* Test Steps */}
          <ScrollArea className="h-[500px] pr-4">
            <div className="space-y-2">
              {steps.map((step, index) => (
                <Card
                  key={step.id}
                  className={`p-3 transition-colors ${
                    currentStepIndex === index ? "border-blue-400 bg-blue-50" :
                    step.status === "success" ? "border-green-200 bg-green-50/50" :
                    step.status === "error" ? "border-red-200 bg-red-50/50" :
                    step.status === "warning" ? "border-yellow-200 bg-yellow-50/50" : ""
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="pt-0.5">{getStatusIcon(step.status)}</div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm">{step.name}</span>
                        {step.duration !== undefined && (
                          <span className="text-xs text-muted-foreground">{step.duration}ms</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>

                      {step.error && (
                        <p className="text-xs text-red-600 mt-1">{step.error}</p>
                      )}

                      {step.result && (step.status === "warning" || step.status === "error") && (
                        <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-x-auto max-h-20">
                          {JSON.stringify(step.result, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </ScrollArea>

          <Separator />

          {/* Actions */}
          <div className="flex justify-between items-center">
            <div className="text-xs text-muted-foreground">
              This test validates identical functionality between development and production environments
            </div>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={resetTest} disabled={isRunning}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                Reset
              </Button>

              <Button size="sm" onClick={runFullTest} disabled={isRunning}>
                <Play className="w-3.5 h-3.5 mr-1" />
                {isRunning ? "Running..." : "Run Full Test"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
