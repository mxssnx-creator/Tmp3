/**
 * Strategy Config Manager
 * Manages independent strategy configuration sets with pseudo positions
 * Each combination = independent set with max 250 positions
 */

import { initRedis, getRedisClient } from "@/lib/redis-db"

export interface StrategyConfig {
  id: string
  connectionId: string
  position_cost_step: number // 2-20
  takeprofit: number // 0.001-0.5
  stoploss: number // 0.001-0.5
  trailing: boolean
  type: "MA_Cross" | "RSI_Band" | "MACD_Signal" | "Bollinger_Bounce" | string
  enabled: boolean
  createdAt: string
}

export interface PseudoPosition {
  entry_time: string
  symbol: string
  entry_price: number
  take_profit: number
  stop_loss: number
  status: "open" | "closed"
  result?: number // PnL percentage when closed
  exit_time?: string
  exit_price?: number
}

export interface StrategyStats {
  totalPositions: number
  openPositions: number
  closedPositions: number
  winRate: number
  totalPnL: number
  avgPnL: number
  bestTrade: number
  worstTrade: number
}

const MAX_POSITIONS = 250

export class StrategyConfigManager {
  private connectionId: string

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  private getConfigKey(configId: string): string {
    return `strategy:${this.connectionId}:config:${configId}`
  }

  private getPositionsKey(configId: string): string {
    return `strategy:${this.connectionId}:config:${configId}:positions`
  }

  async createConfig(config: Omit<StrategyConfig, "connectionId" | "createdAt">): Promise<StrategyConfig> {
    await initRedis()
    const client = getRedisClient()

    const fullConfig: StrategyConfig = {
      ...config,
      connectionId: this.connectionId,
      createdAt: new Date().toISOString(),
    }

    const key = this.getConfigKey(config.id)
    await client.set(key, JSON.stringify(fullConfig))

    console.log(`[v0] [StrategyConfigManager] Created config ${config.id} for ${this.connectionId}`)
    return fullConfig
  }

  async getConfig(configId: string): Promise<StrategyConfig | null> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getConfigKey(configId)
    const data = await client.get(key)

    if (!data) return null
    return JSON.parse(typeof data === "string" ? data : JSON.stringify(data))
  }

  async getAllConfigs(): Promise<StrategyConfig[]> {
    await initRedis()
    const client = getRedisClient()

    const pattern = `strategy:${this.connectionId}:config:*`
    const keys = await client.keys(pattern)

    const configs: StrategyConfig[] = []
    for (const key of keys) {
      if (key.endsWith(":positions")) continue
      const data = await client.get(key)
      if (data) {
        configs.push(JSON.parse(typeof data === "string" ? data : JSON.stringify(data)))
      }
    }

    return configs
  }

  async updateConfig(configId: string, updates: Partial<StrategyConfig>): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const config = await this.getConfig(configId)
    if (!config) {
      throw new Error(`Config ${configId} not found`)
    }

    const updated = { ...config, ...updates }
    const key = this.getConfigKey(configId)
    await client.set(key, JSON.stringify(updated))

    console.log(`[v0] [StrategyConfigManager] Updated config ${configId}`)
  }

  async deleteConfig(configId: string): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const configKey = this.getConfigKey(configId)
    const positionsKey = this.getPositionsKey(configId)

    await client.del(configKey)
    await client.del(positionsKey)

    console.log(`[v0] [StrategyConfigManager] Deleted config ${configId}`)
  }

  async addPosition(configId: string, position: PseudoPosition): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getPositionsKey(configId)
    const entry = [
      position.entry_time,
      position.symbol,
      position.entry_price.toString(),
      position.take_profit.toString(),
      position.stop_loss.toString(),
      position.status,
      position.result?.toString() || "0",
      position.exit_time || "",
      position.exit_price?.toString() || "0",
    ].join("|")

    await client.lpush(key, entry)
    await client.ltrim(key, 0, MAX_POSITIONS - 1)
  }

  async getPositions(configId: string, limit = 50): Promise<PseudoPosition[]> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getPositionsKey(configId)
    const rawPositions = await client.lrange(key, 0, limit - 1)

    return rawPositions.map((entry: string) => {
      const parts = entry.split("|")
      return {
        entry_time: parts[0],
        symbol: parts[1],
        entry_price: parseFloat(parts[2]),
        take_profit: parseFloat(parts[3]),
        stop_loss: parseFloat(parts[4]),
        status: parts[5] as "open" | "closed",
        result: parseFloat(parts[6]),
        exit_time: parts[7] || undefined,
        exit_price: parseFloat(parts[8]) || undefined,
      }
    })
  }

  async getPositionCount(configId: string): Promise<number> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getPositionsKey(configId)
    return await client.llen(key)
  }

  async getStats(configId: string): Promise<StrategyStats> {
    const positions = await this.getPositions(configId, MAX_POSITIONS)

    const closedPositions = positions.filter((p) => p.status === "closed")
    const winningTrades = closedPositions.filter((p) => (p.result || 0) > 0)

    const totalPnL = closedPositions.reduce((sum, p) => sum + (p.result || 0), 0)
    const avgPnL = closedPositions.length > 0 ? totalPnL / closedPositions.length : 0
    const bestTrade = closedPositions.length > 0 ? Math.max(...closedPositions.map((p) => p.result || 0)) : 0
    const worstTrade = closedPositions.length > 0 ? Math.min(...closedPositions.map((p) => p.result || 0)) : 0

    return {
      totalPositions: positions.length,
      openPositions: positions.filter((p) => p.status === "open").length,
      closedPositions: closedPositions.length,
      winRate: closedPositions.length > 0 ? (winningTrades.length / closedPositions.length) * 100 : 0,
      totalPnL,
      avgPnL,
      bestTrade,
      worstTrade,
    }
  }

  async enableConfig(configId: string): Promise<void> {
    await this.updateConfig(configId, { enabled: true })
  }

  async disableConfig(configId: string): Promise<void> {
    await this.updateConfig(configId, { enabled: false })
  }

  async getEnabledConfigs(): Promise<StrategyConfig[]> {
    const allConfigs = await this.getAllConfigs()
    return allConfigs.filter((c) => c.enabled)
  }

  async generateDefaultConfigs(): Promise<StrategyConfig[]> {
    const configs: StrategyConfig[] = []
    let idCounter = 1

    const types = ["MA_Cross", "RSI_Band", "MACD_Signal", "Bollinger_Bounce"]
    const positionCostSteps = [2, 5, 10, 15]
    const takeprofitOptions = [0.01, 0.02, 0.05, 0.1]
    const stoplossOptions = [0.005, 0.01, 0.02, 0.05]

    for (const type of types) {
      for (const posCostStep of positionCostSteps) {
        for (const tp of takeprofitOptions) {
          for (const sl of stoplossOptions) {
            const config = await this.createConfig({
              id: `strat_${this.connectionId}_${idCounter++}`,
              position_cost_step: posCostStep,
              takeprofit: tp,
              stoploss: sl,
              trailing: false,
              type,
              enabled: true,
            })
            configs.push(config)

            if (configs.length >= 100) {
              return configs
            }
          }
        }
      }
    }

    return configs
  }

  async closePosition(
    configId: string,
    symbol: string,
    exitPrice: number,
    exitTime: string = new Date().toISOString()
  ): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const positions = await this.getPositions(configId, MAX_POSITIONS)
    const openPositions = positions.filter((p) => p.symbol === symbol && p.status === "open")

    for (const pos of openPositions) {
      const pnl = ((exitPrice - pos.entry_price) / pos.entry_price) * 100
      const closedPos: PseudoPosition = {
        ...pos,
        status: "closed",
        result: pnl,
        exit_time: exitTime,
        exit_price: exitPrice,
      }

      await this.removePosition(configId, pos.entry_time, pos.symbol)
      await this.addPosition(configId, closedPos)
    }
  }

  private async removePosition(configId: string, entryTime: string, symbol: string): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const key = this.getPositionsKey(configId)
    const positions = await client.lrange(key, 0, -1)

    const filtered = positions.filter((entry: string) => {
      const parts = entry.split("|")
      return !(parts[0] === entryTime && parts[1] === symbol)
    })

    await client.del(key)
    for (const entry of filtered.reverse()) {
      await client.lpush(key, entry)
    }
  }

  async clearAllPositions(): Promise<void> {
    await initRedis()
    const client = getRedisClient()

    const configs = await this.getAllConfigs()
    for (const config of configs) {
      const key = this.getPositionsKey(config.id)
      await client.del(key)
    }

    console.log(`[v0] [StrategyConfigManager] Cleared all positions for ${this.connectionId}`)
  }

  async getBestPerformingConfig(): Promise<{ config: StrategyConfig; stats: StrategyStats } | null> {
    const configs = await this.getEnabledConfigs()
    let best: { config: StrategyConfig; stats: StrategyStats } | null = null

    for (const config of configs) {
      const stats = await this.getStats(config.id)
      if (!best || stats.winRate > best.stats.winRate) {
        best = { config, stats }
      }
    }

    return best
  }
}
