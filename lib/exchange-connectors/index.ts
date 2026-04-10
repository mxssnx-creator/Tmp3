/**
 * Exchange Connector Factory
 * Creates appropriate connector based on exchange name
 * Falls back to CCXT for any supported exchange
 * NOTE: CCXT connector is server-only and loaded dynamically
 */

import type { BaseExchangeConnector, ExchangeCredentials } from "./base-connector"
import { EXCHANGE_API_TYPES } from "@/lib/connection-predefinitions"

// Version marker for cache invalidation
const _CONNECTOR_VERSION = "2.1.0"

// API type aliases - normalize common variations
const API_TYPE_ALIASES: Record<string, string> = {
  perpetual_futures: "perpetual",
  futures: "perpetual",
  perp: "perpetual",
  swap: "perpetual",
}

export async function createExchangeConnector(
  exchange: string,
  credentials: ExchangeCredentials
): Promise<BaseExchangeConnector> {
  const normalizedExchange = exchange.toLowerCase().replace(/[^a-z]/g, "")

  // Normalize API type using aliases
  if (credentials.apiType && API_TYPE_ALIASES[credentials.apiType]) {
    credentials.apiType = API_TYPE_ALIASES[credentials.apiType]
  }
  
  // Validate API type is supported for the exchange
  if (credentials.apiType) {
    const supported = EXCHANGE_API_TYPES[normalizedExchange]
    if (supported && !supported.includes(credentials.apiType)) {
      throw new Error(
        `Invalid API type '${credentials.apiType}' for ${exchange}. Supported: ${supported.join(", ")}`
      )
    }
  }

  switch (normalizedExchange) {
    case "bybit": {
      const { BybitConnector } = await import("./bybit-connector")
      return new BybitConnector(credentials, "bybit")
    }
    case "bingx": {
      const { BingXConnector } = await import("./bingx-connector")
      return new BingXConnector(credentials, "bingx")
    }
    case "pionex": {
      const { PionexConnector } = await import("./pionex-connector")
      return new PionexConnector(credentials, "pionex")
    }
    case "orangex": {
      const { OrangeXConnector } = await import("./orangex-connector")
      return new OrangeXConnector(credentials, "orangex")
    }
    case "binance": {
      const { BinanceConnector } = await import("./binance-connector")
      return new BinanceConnector(credentials, "binance")
    }
    case "okx": {
      const { OKXConnector } = await import("./okx-connector")
      return new OKXConnector(credentials, "okx")
    }
    default:
      throw new Error(
        `Unsupported exchange: ${exchange}. Supported exchanges: bybit, bingx, pionex, orangex, binance, okx`
      )
  }
}

export type { ExchangeConnectorResult, ExchangeCredentials } from "./base-connector"
export { BaseExchangeConnector } from "./base-connector"
