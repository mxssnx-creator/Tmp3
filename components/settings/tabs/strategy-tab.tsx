"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import AutoIndicationSettings from "@/components/settings/auto-indication-settings"
import MultiTrailingSettings from "@/components/settings/strategy/multi-trailing-settings"
import { useState } from "react"

interface StrategyTabProps {
  settings: any
  handleSettingChange: (key: string, value: any) => void
}

export function StrategyTab({ settings, handleSettingChange }: StrategyTabProps) {
  const [strategySubTab, setStrategySubTab] = useState("main")
  const [strategyMainSubTab, setStrategyMainSubTab] = useState("base")

  return (
    <TabsContent value="strategy" className="space-y-4">
      <Tabs value={strategySubTab} onValueChange={setStrategySubTab}>
        <TabsList>
          <TabsTrigger value="main">Main</TabsTrigger>
          <TabsTrigger value="preset">Preset</TabsTrigger>
          <TabsTrigger value="auto">Auto</TabsTrigger>
        </TabsList>

        <TabsContent value="main" className="space-y-4">
          <Tabs value={strategyMainSubTab} onValueChange={setStrategyMainSubTab}>
            <TabsList>
              <TabsTrigger value="base">Base</TabsTrigger>
              <TabsTrigger value="trailing">Trailing</TabsTrigger>
              <TabsTrigger value="adjustment">Adjustment</TabsTrigger>
            </TabsList>

            <TabsContent value="base" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Base Strategy Configuration</CardTitle>
                  <CardDescription>Configure base strategy parameters</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/*
                   * ── Main Trade Profit Factor Thresholds ────────────────
                   *
                   * Spec: "Change at Main Trade PF for Base, Main, Real,
                   * Live to 0.9 1.0 1.0 1.0 System Overall. Add to
                   * Settings Dialog at Strategies with Sliders. Ensure
                   * it works systemwide completely."
                   *
                   * Each slider tunes the minimum profit-factor gate for
                   * one stage of the Main-Trade pipeline (Base → Main →
                   * Real → Live). Values flow into the engine via
                   * `lib/strategy-coordinator.ts:loadAppPFThresholds()`,
                   * which mirrors them into:
                   *   - `PF_BASE_MIN`  — per-indication entry filter
                   *   - `METRICS.{base,main,real,live}.minProfitFactor`
                   *     — Set-average promotion gates
                   *
                   * Cache TTL is 5s so a slider change reflects in live
                   * gating within at most 5 seconds, no engine restart
                   * required. Range 0.0–2.0 with 0.1 step matches the
                   * existing Preset PF slider for UX consistency.
                   * Defaults match the spec exactly: 0.9 / 1.0 / 1.0 / 1.0.
                   */}
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold">Main Trade Profit Factor Thresholds</h3>
                    <p className="text-xs text-muted-foreground">
                      Minimum profit factor required to promote Sets between
                      Main-Trade stages. Defaults: Base 0.9, Main 1.0,
                      Real 1.0, Live 1.0.
                    </p>
                  </div>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Base PF Threshold</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={0.0}
                          max={2.0}
                          step={0.1}
                          value={[settings.baseProfitFactor ?? 0.9]}
                          onValueChange={([value]) => handleSettingChange("baseProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.baseProfitFactor ?? 0.9).toFixed(1)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Per-indication entry filter for Base Sets.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Main PF Threshold</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={0.0}
                          max={2.0}
                          step={0.1}
                          value={[settings.mainProfitFactor ?? 1.0]}
                          onValueChange={([value]) => handleSettingChange("mainProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.mainProfitFactor ?? 1.0).toFixed(1)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Avg PF gate to promote Base Sets into Main.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Real PF Threshold</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={0.0}
                          max={2.0}
                          step={0.1}
                          value={[settings.realProfitFactor ?? 1.0]}
                          onValueChange={([value]) => handleSettingChange("realProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.realProfitFactor ?? 1.0).toFixed(1)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Avg PF gate to promote Main Sets into Real.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Live PF Threshold</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={0.0}
                          max={2.0}
                          step={0.1}
                          value={[settings.liveProfitFactor ?? 1.0]}
                          onValueChange={([value]) => handleSettingChange("liveProfitFactor", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-10 text-right">
                          {(settings.liveProfitFactor ?? 1.0).toFixed(1)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Avg PF gate to promote Real Sets into Live.
                      </p>
                    </div>
                  </div>

                  <Separator />

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Maximum Drawdown Time (hours)</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          min={1}
                          max={72}
                          step={1}
                          value={[settings.maxDrawdownTimeHours || 24]}
                          onValueChange={([value]) => handleSettingChange("maxDrawdownTimeHours", value)}
                          className="flex-1"
                        />
                        <span className="text-sm font-medium w-16 text-right">
                          {settings.maxDrawdownTimeHours || 24}h
                        </span>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">Trading Range Configuration</h3>
                    <p className="text-xs text-muted-foreground">
                      Define ranges for base value and ratios to control position sizing and risk.
                    </p>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Base Value Range (Min/Max)</Label>
                        <div className="flex items-center gap-4">
                          <Slider
                            min={0.1}
                            max={5.0}
                            step={0.1}
                            value={[settings.baseValueRangeMin || 0.5, settings.baseValueRangeMax || 2.5]}
                            onValueChange={([min, max]) => {
                              handleSettingChange("baseValueRangeMin", min)
                              handleSettingChange("baseValueRangeMax", max)
                            }}
                            className="flex-1"
                          />
                          <span className="text-sm font-medium w-24 text-right">
                            {settings.baseValueRangeMin?.toFixed(1)} - {settings.baseValueRangeMax?.toFixed(1)}
                          </span>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Base Ratio Range (Min/Max)</Label>
                        <div className="flex items-center gap-4">
                          <Slider
                            min={0.1}
                            max={1.0}
                            step={0.1}
                            value={[settings.baseRatioMin || 0.2, settings.baseRatioMax || 1.0]}
                            onValueChange={([min, max]) => {
                              handleSettingChange("baseRatioMin", min)
                              handleSettingChange("baseRatioMax", max)
                            }}
                            className="flex-1"
                          />
                          <span className="text-sm font-medium w-20 text-right">
                            {settings.baseRatioMin?.toFixed(1)} - {settings.baseRatioMax?.toFixed(1)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="trailing" className="space-y-4">
              {/*
               * Multi-step trailing matrix per spec — Settings →
               * Strategy → Main → Trailing. Each enabled (start, stop)
               * combo spawns one independent Base Set per
               * (indication_type × direction); engine consumes them
               * via `getEnabledTrailingVariants()` in
               * `lib/strategy-coordinator.ts`.
               */}
              <MultiTrailingSettings
                settings={settings}
                handleSettingChange={handleSettingChange}
              />
            </TabsContent>

            <TabsContent value="adjustment" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Adjustment Strategies</CardTitle>
                  <CardDescription>Configure block and DCA adjustments</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid md:grid-cols-2 gap-6">
                    <div className="flex items-center justify-between p-4 border rounded-lg">
                      <div>
                        <Label>Block Adjustment</Label>
                        <p className="text-xs text-muted-foreground">
                          Adjusts positions based on predefined blocks or segments
                        </p>
                      </div>
                      <Switch
                        checked={settings.blockAdjustment !== false}
                        onCheckedChange={(checked) => handleSettingChange("blockAdjustment", checked)}
                      />
                    </div>

                    <div className="flex items-center justify-between p-4 border rounded-lg">
                      <div>
                        <Label>DCA (Dollar Cost Averaging)</Label>
                        <p className="text-xs text-muted-foreground">
                          Automatically adds to positions at lower prices
                        </p>
                      </div>
                      <Switch
                        checked={settings.dcaAdjustment !== false}
                        onCheckedChange={(checked) => handleSettingChange("dcaAdjustment", checked)}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="preset" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Preset Strategy Configuration</CardTitle>
              <CardDescription>Configure preset strategy parameters</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Minimum Profit Factor</Label>
                  <div className="flex items-center gap-4">
                    <Slider
                      min={0.1}
                      max={2.0}
                      step={0.1}
                      value={[settings.profitFactorMinPreset || 0.6]}
                      onValueChange={([value]) => handleSettingChange("profitFactorMinPreset", value)}
                      className="flex-1"
                    />
                    <span className="text-sm font-medium w-10 text-right">
                      {(settings.profitFactorMinPreset || 0.6).toFixed(1)}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Maximum Drawdown Time (hours)</Label>
                  <div className="flex items-center gap-4">
                    <Slider
                      min={1}
                      max={72}
                      step={1}
                      value={[settings.drawdownTimePreset || 24]}
                      onValueChange={([value]) => handleSettingChange("drawdownTimePreset", value)}
                      className="flex-1"
                    />
                    <span className="text-sm font-medium w-16 text-right">
                      {settings.drawdownTimePreset || 24}h
                    </span>
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Strategy Type Enabling</h3>
                <p className="text-xs text-muted-foreground">
                  Enable or disable specific strategy types for preset trading.
                </p>
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="flex items-center justify-between p-4 border rounded-lg">
                    <div>
                      <Label>Trailing Strategy</Label>
                      <p className="text-xs text-muted-foreground">Enable trailing stop strategy</p>
                    </div>
                    <Switch
                      checked={settings.presetTrailingEnabled === true}
                      onCheckedChange={(checked) => handleSettingChange("presetTrailingEnabled", checked)}
                    />
                  </div>

                  <div className="flex items-center justify-between p-4 border rounded-lg">
                    <div>
                      <Label>Block Strategy</Label>
                      <p className="text-xs text-muted-foreground">Enable block trading strategy</p>
                    </div>
                    <Switch
                      checked={settings.presetBlockEnabled === true}
                      onCheckedChange={(checked) => handleSettingChange("presetBlockEnabled", checked)}
                    />
                  </div>

                  <div className="flex items-center justify-between p-4 border rounded-lg">
                    <div>
                      <Label>DCA Strategy</Label>
                      <p className="text-xs text-muted-foreground">Enable Dollar Cost Averaging strategy</p>
                    </div>
                    <Switch
                      checked={settings.presetDcaEnabled === true}
                      onCheckedChange={(checked) => handleSettingChange("presetDcaEnabled", checked)}
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="auto">
          <AutoIndicationSettings />
        </TabsContent>
      </Tabs>
    </TabsContent>
  )
}
