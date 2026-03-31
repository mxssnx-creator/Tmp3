"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Activity, Database, Wifi, BarChart3, Layers, AlertCircle } from "lucide-react"

interface OverallSummaryProps {
  data: {
    symbolCount: number
    prehistoricLoadedSymbols: number
    prehistoricTotalSymbols: number
    prehistoricTotalCandles: number
    prehistoricCompleted: boolean
    wsSymbolsConnected: number
    wsTotalSymbols: number
    wsMessagesTotal: number
    totalIndicationCycles: number
    totalStrategyCycles: number
    totalRealtimeCycles: number
    indicationSummary: {
      totalEvaluations: number
      overallPassRate: number
      typesTracked: number
    }
    strategySummary: {
      totalEvaluated: number
      overallPassRate: number
      avgProfitFactor: number
      avgDrawdownTime: number
    }
    errorCount: number
    logCount: number
  }
}

export function OverallSummary({ data }: OverallSummaryProps) {
  const totalCycles = data.totalIndicationCycles + data.totalStrategyCycles + data.totalRealtimeCycles
  const prehistoricPercent = data.prehistoricTotalSymbols > 0 
    ? (data.prehistoricLoadedSymbols / data.prehistoricTotalSymbols) * 100 
    : 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Overall Summary
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {/* Symbols */}
          <div className="text-center p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
            <Database className="h-5 w-5 mx-auto mb-1 text-blue-600" />
            <div className="text-2xl font-bold">{data.symbolCount}</div>
            <div className="text-xs text-muted-foreground">Symbols</div>
          </div>

          {/* Prehistoric */}
          <div className="text-center p-3 bg-purple-50 dark:bg-purple-950/20 rounded-lg">
            <Database className="h-5 w-5 mx-auto mb-1 text-purple-600" />
            <div className="text-2xl font-bold">{data.prehistoricTotalCandles}</div>
            <div className="text-xs text-muted-foreground">Candles</div>
            <Progress value={prehistoricPercent} className="h-1 mt-1" />
          </div>

          {/* Processing */}
          <div className="text-center p-3 bg-green-50 dark:bg-green-950/20 rounded-lg">
            <BarChart3 className="h-5 w-5 mx-auto mb-1 text-green-600" />
            <div className="text-2xl font-bold">{totalCycles}</div>
            <div className="text-xs text-muted-foreground">Total Cycles</div>
          </div>

          {/* Errors */}
          <div className="text-center p-3 bg-red-50 dark:bg-red-950/20 rounded-lg">
            <AlertCircle className="h-5 w-5 mx-auto mb-1 text-red-600" />
            <div className="text-2xl font-bold">{data.errorCount}</div>
            <div className="text-xs text-muted-foreground">Errors</div>
          </div>
        </div>

        {/* Detailed Metrics */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          {/* WebSocket */}
          <div className="flex items-center gap-2 p-2 bg-muted/30 rounded">
            <Wifi className="h-4 w-4 text-muted-foreground" />
            <div>
              <span className="text-muted-foreground">WS:</span>{" "}
              <Badge variant={data.wsSymbolsConnected > 0 ? "default" : "secondary"} className="text-xs">
                {data.wsSymbolsConnected}/{data.wsTotalSymbols}
              </Badge>
              <span className="ml-2 text-muted-foreground">Msgs:</span> {data.wsMessagesTotal}
            </div>
          </div>

          {/* Indications */}
          <div className="flex items-center gap-2 p-2 bg-muted/30 rounded">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <div>
              <span className="text-muted-foreground">Indications:</span>{" "}
              <Badge variant="secondary" className="text-xs">
                {data.indicationSummary.totalEvaluations} evals
              </Badge>
              <span className="ml-2 text-muted-foreground">Pass:</span>{" "}
              <span className="text-green-600 font-medium">{Math.round(data.indicationSummary.overallPassRate)}%</span>
            </div>
          </div>

          {/* Strategies */}
          <div className="flex items-center gap-2 p-2 bg-muted/30 rounded">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <div>
              <span className="text-muted-foreground">Strategies:</span>{" "}
              <Badge variant="secondary" className="text-xs">
                {data.strategySummary.totalEvaluated} evals
              </Badge>
              <span className="ml-2 text-muted-foreground">PF:</span>{" "}
              <span className="font-medium">{data.strategySummary.avgProfitFactor.toFixed(2)}</span>
            </div>
          </div>

          {/* Processing Cycles */}
          <div className="flex items-center gap-2 p-2 bg-muted/30 rounded">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <div>
              <span className="text-muted-foreground">Cycles:</span>{" "}
              <span className="font-medium">{data.totalIndicationCycles}</span> ind,{" "}
              <span className="font-medium">{data.totalStrategyCycles}</span> strat,{" "}
              <span className="font-medium">{data.totalRealtimeCycles}</span> rt
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
