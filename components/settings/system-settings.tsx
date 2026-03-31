"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, Loader2, Zap } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface RiskSettings {
  enabled: boolean
  maxOpenPositions: string
  dailyLossLimitPercent: number
  maxDrawdownPercent: number
  positionSizeLimit: number
  stopLossEnabled: boolean
  takeProfitEnabled: boolean
}

interface EngineSettings {
  presetTradeEngine: boolean
  mainTradeEngine: boolean
  realtimePositionsEngine: boolean
  riskManagementEngine: boolean
}

export function SystemSettings() {
  const [riskSettings, setRiskSettings] = useState<RiskSettings | null>(null)
  const [engineSettings, setEngineSettings] = useState<EngineSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const response = await fetch("/api/settings/risk-and-engines")
      if (response.ok) {
        const data = await response.json()
        setRiskSettings(data.riskManagement)
        setEngineSettings(data.engines)
      }
    } catch (error) {
      console.error("[v0] Error loading settings:", error)
      toast.error("Failed to load settings")
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const response = await fetch("/api/settings/risk-and-engines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          riskManagement: riskSettings,
          engines: engineSettings,
        }),
      })

      if (response.ok) {
        toast.success("Settings saved successfully")
      } else {
        toast.error("Failed to save settings")
      }
    } catch (error) {
      console.error("[v0] Error saving settings:", error)
      toast.error("Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  if (loading || !riskSettings || !engineSettings) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Trade Engines */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-blue-600" />
            <div>
              <CardTitle>Trade Engines</CardTitle>
              <CardDescription>Enable or disable individual trade processing engines</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Preset Trade Engine */}
            <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50 transition">
              <div className="flex-1">
                <Label className="font-medium text-sm cursor-pointer">Preset Trade Engine</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Runs preset strategies using common indicators
                </p>
              </div>
              <input
                type="checkbox"
                checked={engineSettings.presetTradeEngine}
                onChange={(e) =>
                  setEngineSettings({
                    ...engineSettings,
                    presetTradeEngine: e.target.checked,
                  })
                }
                className="w-5 h-5 rounded cursor-pointer"
              />
            </div>

            {/* Main Trade Engine */}
            <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50 transition">
              <div className="flex-1">
                <Label className="font-medium text-sm cursor-pointer">Main Trade Engine</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Processes step indication based trades
                </p>
              </div>
              <input
                type="checkbox"
                checked={engineSettings.mainTradeEngine}
                onChange={(e) =>
                  setEngineSettings({
                    ...engineSettings,
                    mainTradeEngine: e.target.checked,
                  })
                }
                className="w-5 h-5 rounded cursor-pointer"
              />
            </div>

            {/* Realtime Positions Engine */}
            <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50 transition">
              <div className="flex-1">
                <Label className="font-medium text-sm cursor-pointer">Realtime Positions Engine</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Monitors positions via WebSocket real-time updates
                </p>
              </div>
              <input
                type="checkbox"
                checked={engineSettings.realtimePositionsEngine}
                onChange={(e) =>
                  setEngineSettings({
                    ...engineSettings,
                    realtimePositionsEngine: e.target.checked,
                  })
                }
                className="w-5 h-5 rounded cursor-pointer"
              />
            </div>

            {/* Risk Management Engine */}
            <div className="flex items-center justify-between p-3 border rounded-lg bg-slate-50 opacity-50 cursor-not-allowed">
              <div className="flex-1">
                <Label className="font-medium text-sm">Risk Management Engine</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Enforces position and loss limits (disabled)
                </p>
              </div>
              <input
                type="checkbox"
                checked={engineSettings.riskManagementEngine}
                disabled
                className="w-5 h-5 rounded opacity-50 cursor-not-allowed"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Risk Management Settings */}
      <Card className="border-amber-200 bg-amber-50/50">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>Risk Management Settings</CardTitle>
              <CardDescription>Configure position and loss limits</CardDescription>
            </div>
            <Badge variant="secondary" className="bg-amber-200 text-amber-900">
              Currently Disabled
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 opacity-60 pointer-events-none">
          <div className="p-3 bg-amber-100 border border-amber-300 rounded-lg flex gap-2">
            <AlertCircle className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900">
              <p className="font-medium">Risk management is currently disabled for safety.</p>
              <p className="text-xs mt-1">These settings are defaults and are shown for reference only.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Max Open Positions */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Max Open Positions</Label>
              <Input
                type="text"
                value={riskSettings.maxOpenPositions}
                disabled
                className="bg-white"
              />
              <p className="text-xs text-muted-foreground">
                Limit: <span className="font-mono font-bold">{riskSettings.maxOpenPositions}</span>
              </p>
            </div>

            {/* Daily Loss Limit */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Daily Loss Limit</Label>
              <Input
                type="number"
                value={riskSettings.dailyLossLimitPercent}
                disabled
                className="bg-white"
              />
              <p className="text-xs text-muted-foreground">
                Default: <span className="font-mono font-bold">{riskSettings.dailyLossLimitPercent}%</span> of account
              </p>
            </div>

            {/* Max Drawdown */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Max Drawdown</Label>
              <Input
                type="number"
                value={riskSettings.maxDrawdownPercent}
                disabled
                className="bg-white"
              />
              <p className="text-xs text-muted-foreground">
                Default: <span className="font-mono font-bold">{riskSettings.maxDrawdownPercent}%</span> of account
              </p>
            </div>

            {/* Position Size Limit */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Position Size Limit</Label>
              <Input
                type="number"
                value={riskSettings.positionSizeLimit}
                disabled
                className="bg-white"
              />
              <p className="text-xs text-muted-foreground">
                Maximum: <span className="font-mono font-bold">${riskSettings.positionSizeLimit.toLocaleString()}</span>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={loadSettings} disabled={saving}>
          Reset
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </div>
  )
}
