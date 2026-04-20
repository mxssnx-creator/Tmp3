"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { Info } from "lucide-react"
import { StatisticsOverview } from "@/components/settings/statistics-overview"

interface SystemTabProps {
  settings: any
  handleSettingChange: (key: string, value: any) => void
}

export function SystemTab({ settings, handleSettingChange }: SystemTabProps) {
  return (
    <Tabs defaultValue="system" className="space-y-4">
      <TabsContent value="system" className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>System Configuration</CardTitle>
            <CardDescription>Core system settings, database management, and application logs</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Database Configuration</h3>
              <p className="text-xs text-muted-foreground">
                The system uses Redis for high-performance in-memory data storage.
              </p>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Database Type</Label>
                  <div className="flex items-center gap-3 p-4 border rounded-lg bg-primary/5">
                    <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
                    <div>
                      <p className="font-semibold text-lg">Redis</p>
                      <p className="text-xs text-muted-foreground">In-Memory Data Store</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <strong>Redis</strong> provides high-performance data storage with millisecond latency, 
                    perfect for real-time trading applications.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Connection Status</Label>
                  <div className="p-3 border rounded-lg bg-muted/30">
                    <p className="text-sm">
                      <strong>Mode:</strong> {settings.databaseType === "redis" ? "Persistent Redis" : "In-Memory Fallback"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Configure REDIS_URL environment variable for persistent storage.
                      Without it, data will be stored in-memory and lost on restart.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-semibold">Position Limits</h3>
              <p className="text-xs text-muted-foreground">Maximum positions per configuration per direction</p>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Max Long Positions per Config</Label>
                    <span className="text-sm font-semibold">{settings.maxPositionsLong ?? 1}</span>
                  </div>
                  <Slider
                    value={[settings.maxPositionsLong ?? 1]}
                    onValueChange={(v) => handleSettingChange("maxPositionsLong", v[0])}
                    min={1}
                    max={5}
                    step={1}
                  />
                  <p className="text-xs text-muted-foreground">Max 1 recommended for independent config processing</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Max Short Positions per Config</Label>
                    <span className="text-sm font-semibold">{settings.maxPositionsShort ?? 1}</span>
                  </div>
                  <Slider
                    value={[settings.maxPositionsShort ?? 1]}
                    onValueChange={(v) => handleSettingChange("maxPositionsShort", v[0])}
                    min={1}
                    max={5}
                    step={1}
                  />
                  <p className="text-xs text-muted-foreground">Max 1 recommended for independent config processing</p>
                </div>
              </div>
            </div>

              <div className="space-y-4 border-t pt-4">
                <h3 className="text-lg font-semibold">Database Operation Limits</h3>
                <p className="text-xs text-muted-foreground">
                  Control maximum database write operations to prevent unbounded growth
                </p>

                <div className="space-y-4">
                  {/* Per Second Limit */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Operations per Second</Label>
                      <span className="text-sm font-semibold">
                        {settings.databaseLimitPerSecond === 0
                          ? "Unlimited"
                          : `${(settings.databaseLimitPerSecond / 1000).toFixed(1)}k`}
                      </span>
                    </div>
                    <Slider
                      value={[settings.databaseLimitPerSecond ?? 10000]}
                      onValueChange={(v) => handleSettingChange("databaseLimitPerSecond", v[0])}
                      min={0}
                      max={100000}
                      step={1000}
                    />
                    <p className="text-xs text-muted-foreground">
                      Set to 0 for unlimited, or choose a per-second limit (1k - 100k). Default: 10k ops/sec.
                    </p>
                    {settings.databaseLimitPerSecond > 0 && (
                      <div className="p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-900">
                        <strong>Current Limit:</strong> {(settings.databaseLimitPerSecond / 1000).toFixed(1)}k operations/sec
                      </div>
                    )}
                  </div>

                  {/* Per Minute Limit */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Operations per Minute</Label>
                      <span className="text-sm font-semibold">
                        {settings.databaseLimitPerMinute === 0
                          ? "Unlimited"
                          : `${(settings.databaseLimitPerMinute / 1000).toFixed(0)}k`}
                      </span>
                    </div>
                    <Slider
                      value={[settings.databaseLimitPerMinute ?? 500000]}
                      onValueChange={(v) => handleSettingChange("databaseLimitPerMinute", v[0])}
                      min={0}
                      max={3000000}
                      step={100000}
                    />
                    <p className="text-xs text-muted-foreground">
                      Set to 0 for unlimited operations, or choose a limit (100k - 3M per minute).
                      Default: 500k. Applies to trades, positions, and other write operations.
                    </p>
                    {settings.databaseLimitPerMinute > 0 && (
                      <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900">
                        <strong>Current Limit:</strong> {(settings.databaseLimitPerMinute / 1000).toFixed(0)}k operations/min
                      </div>
                    )}
                  </div>
                </div>
              </div>

             <div className="space-y-4 border-t pt-4">
               <h3 className="text-lg font-semibold">Indication Timeout</h3>
               <p className="text-xs text-muted-foreground">Time to wait for valid indication evaluation (100ms - 3000ms)</p>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Indication Timeout</Label>
                  <span className="text-sm font-semibold">{settings.indicationTimeoutMs ?? 1000}ms</span>
                </div>
                <Slider
                  value={[settings.indicationTimeoutMs ?? 1000]}
                  onValueChange={(v) => handleSettingChange("indicationTimeoutMs", v[0])}
                  min={100}
                  max={3000}
                  step={100}
                />
                <p className="text-xs text-muted-foreground">
                  After a valid indication evaluation, wait this duration before processing next.
                  Lower values = faster but more CPU. Higher values = more reliable but slower response.
                </p>
              </div>
            </div>

            {/* Cycle Pause — pause between engine cycles (indication / strategy / realtime).
                Changes take effect within ~10s as the engine refreshes the cached value. */}
            <div className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-semibold">Engine Cycle Pause</h3>
              <p className="text-xs text-muted-foreground">
                Pause between successive engine cycles (10ms – 200ms). Prevents the
                event loop from starving under heavy workloads and keeps average
                cycle time stable. Default 50ms.
              </p>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Cycle Pause</Label>
                  <span className="text-sm font-semibold tabular-nums">
                    {settings.cyclePauseMs ?? 50}ms
                  </span>
                </div>
                <Slider
                  value={[settings.cyclePauseMs ?? 50]}
                  onValueChange={(v) => handleSettingChange("cyclePauseMs", v[0])}
                  min={10}
                  max={200}
                  step={10}
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>10ms</span>
                  <span>Default 50ms</span>
                  <span>200ms</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Lower values = higher throughput but more CPU pressure.
                  Higher values = lower CPU and more time for other I/O between cycles.
                  Applied to indication, strategy and realtime loops.
                </p>
              </div>
            </div>

            <div className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-semibold">Data Retention Settings</h3>
              <p className="text-xs text-muted-foreground">Configure automatic cleanup of old data</p>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Market Data Retention (Days)</Label>
                  <Select
                    value={String(settings.market_data_retention_days || 30)}
                    onValueChange={(value) => handleSettingChange("market_data_retention_days", Number.parseInt(value))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7">7 days</SelectItem>
                      <SelectItem value="14">14 days</SelectItem>
                      <SelectItem value="30">30 days</SelectItem>
                      <SelectItem value="60">60 days</SelectItem>
                      <SelectItem value="90">90 days</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Historical market data older than this will be removed</p>
                </div>

                <div className="space-y-2">
                  <Label>Indication State Retention (Hours)</Label>
                  <Select
                    value={String(settings.indication_state_retention_hours || 48)}
                    onValueChange={(value) =>
                      handleSettingChange("indication_state_retention_hours", Number.parseInt(value))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="24">24 hours</SelectItem>
                      <SelectItem value="48">48 hours</SelectItem>
                      <SelectItem value="72">72 hours</SelectItem>
                      <SelectItem value="168">7 days</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Old indication states older than this will be removed</p>
                </div>
              </div>
            </div>

            <div className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-semibold">Database Statistics</h3>
              <StatisticsOverview settings={settings} />
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}
