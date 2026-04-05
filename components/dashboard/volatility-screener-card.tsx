"use client"

import React, { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TrendingUp, TrendingDown, AlertCircle, CheckCircle2 } from "lucide-react"
import type { VolatilityMetrics } from "@/lib/volatility-calculator"

interface VolatilityScreenResult {
  success: boolean
  timestamp: string
  screened: number
  highVolatile: number
  results: Array<{
    symbol: string
    volatility: string
    score: number
    range: string
    isHighVolatility: boolean
  }>
  selectedSymbols: string[]
}

export function VolatilityScreenerCard() {
  const [screening, setScreening] = useState(false)
  const [results, setResults] = useState<VolatilityScreenResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const screenSymbols = async () => {
    setScreening(true)
    setError(null)
    try {
      const response = await fetch("/api/symbols/screen-volatility", { cache: "no-store" })
      if (!response.ok) throw new Error("Failed to screen symbols")
      const data = await response.json()
      setResults(data)
    } catch (err) {
      setError((err as Error).message)
      console.error("[v0] Error screening symbols:", err)
    } finally {
      setScreening(false)
    }
  }

  useEffect(() => {
    // Auto-screen on mount
    screenSymbols()
  }, [])

  return (
    <Card className="border-0 shadow-md">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-green-500" />
              High Volatility Screener
            </CardTitle>
            <CardDescription>
              Last Hour Analysis - Symbols with &gt;2% price range
            </CardDescription>
          </div>
          <Button
            onClick={screenSymbols}
            disabled={screening}
            variant="outline"
            size="sm"
          >
            {screening ? "Scanning..." : "Rescan"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {results && (
          <>
            {/* Summary Stats */}
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-lg bg-blue-50 p-2">
                <div className="text-xs text-blue-600">Total Screened</div>
                <div className="text-lg font-semibold text-blue-700">{results.screened}</div>
              </div>
              <div className="rounded-lg bg-green-50 p-2">
                <div className="text-xs text-green-600">High Volatility</div>
                <div className="text-lg font-semibold text-green-700">{results.highVolatile}</div>
              </div>
              <div className="rounded-lg bg-purple-50 p-2">
                <div className="text-xs text-purple-600">Selected</div>
                <div className="text-lg font-semibold text-purple-700">{results.selectedSymbols.length}</div>
              </div>
            </div>

            {/* Selected Symbols */}
            {results.selectedSymbols.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {results.selectedSymbols.map((symbol) => (
                  <Badge key={symbol} variant="default" className="text-base py-1 px-2">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    {symbol}
                  </Badge>
                ))}
              </div>
            )}

            {/* Detailed Results */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {results.results.length > 0 ? (
                results.results.map((result, idx) => (
                  <div
                    key={result.symbol}
                    className={`rounded-lg p-3 border ${
                      result.isHighVolatility
                        ? "border-green-200 bg-green-50"
                        : "border-gray-200 bg-gray-50"
                    }`}
                  >
                    <div className="flex items-start justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-lg">{result.symbol}</span>
                        {result.isHighVolatility ? (
                          <Badge variant="secondary" className="bg-green-100 text-green-800">
                            ✓ High Vol
                          </Badge>
                        ) : (
                          <Badge variant="outline">Standard</Badge>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-green-600">
                          {result.volatility} Range
                        </div>
                        <div className="text-xs text-gray-500">
                          Score: {result.score}/100
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-gray-600">
                      Price Range: {result.range}
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-700">
                  No high-volatility symbols found in the last hour. Try again later.
                </div>
              )}
            </div>

            {/* Last Updated */}
            <div className="text-xs text-gray-500 text-center">
              Updated: {new Date(results.timestamp).toLocaleTimeString()}
            </div>
          </>
        )}

        {!results && !error && (
          <div className="text-center py-4">
            <div className="text-sm text-gray-500">Initializing volatility screener...</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
