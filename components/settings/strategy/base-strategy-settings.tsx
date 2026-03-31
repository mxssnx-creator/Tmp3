"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

export default function BaseStrategySettings({
  settings,
  handleSettingChange,
}: {
  settings: any
  handleSettingChange: (key: string, value: any) => void
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Base Strategy Configuration</CardTitle>
          <CardDescription>
            Configure base-level strategy parameters that form the foundation of position calculations
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Value Range Settings</h3>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Base Value Min</Label>
                <Input
                  type="number"
                  min="0.1"
                  max="5"
                  step="0.1"
                  value={settings.strategyBaseValueMin || 0.5}
                  onChange={(e) => handleSettingChange("strategyBaseValueMin", Number.parseFloat(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">Minimum base value for position sizing (default: 0.5)</p>
              </div>

              <div className="space-y-2">
                <Label>Base Value Max</Label>
                <Input
                  type="number"
                  min="0.5"
                  max="10"
                  step="0.1"
                  value={settings.strategyBaseValueMax || 2.5}
                  onChange={(e) => handleSettingChange("strategyBaseValueMax", Number.parseFloat(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">Maximum base value for position sizing (default: 2.5)</p>
              </div>
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Ratio Settings</h3>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Base Ratio Min</Label>
                <Input
                  type="number"
                  min="0.1"
                  max="2"
                  step="0.1"
                  value={settings.strategyBaseRatioMin || 0.2}
                  onChange={(e) => handleSettingChange("strategyBaseRatioMin", Number.parseFloat(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Minimum base ratio for volume calculations (default: 0.2)
                </p>
              </div>

              <div className="space-y-2">
                <Label>Base Ratio Max</Label>
                <Input
                  type="number"
                  min="0.5"
                  max="5"
                  step="0.1"
                  value={settings.strategyBaseRatioMax || 1.0}
                  onChange={(e) => handleSettingChange("strategyBaseRatioMax", Number.parseFloat(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum base ratio for volume calculations (default: 1.0)
                </p>
              </div>
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Base Strategy Features</h3>

            <div className="grid gap-4">
              <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
                <div>
                  <Label className="text-base">Base Trailing Enabled</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Enable trailing stop loss for base strategy positions
                  </p>
                </div>
                <Switch
                  checked={settings.strategyBaseTrailing !== false}
                  onCheckedChange={(checked) => handleSettingChange("strategyBaseTrailing", checked)}
                />
              </div>
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Profit Factor</h3>

            <div className="space-y-2">
              <Label>Base Min Profit Factor</Label>
              <Input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={settings.strategyBaseMinProfitFactor || 0.4}
                onChange={(e) => handleSettingChange("strategyBaseMinProfitFactor", Number.parseFloat(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Minimum profit factor required for base strategy execution (default: 0.4)
              </p>
            </div>
          </div>

          <div className="p-4 bg-muted rounded-lg space-y-3">
            <h4 className="text-sm font-semibold">Base Strategy Overview</h4>
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                The Base Strategy forms the foundation of all position calculations. It determines the initial position
                sizes and volume allocations.
              </p>
              <p>
                Value ranges control the multiplier applied to position sizing, while ratio settings determine volume
                distribution across different positions.
              </p>
              <p>
                Base trailing enables automatic profit protection at the foundational level, moving stop losses as
                positions become profitable.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
