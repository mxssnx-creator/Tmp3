/**
 * Exchange Connector Factory
 * Creates appropriate connector based on exchange name
 * Falls back to CCXT for any supported exchange
 * NOTE: CCXT connector is server-only and loaded dynamically
 */

import type { BaseExchangeConnector, ExchangeCredentials } from "./base-connector"
import { EXCHANGE_API_TYPES } from "@/lib/connection-predefinitions"

// Version marker for cache invalidation
const _CONNECTOR_VERSION = "2.3.0"

// Log once to confirm new code is running
console.log("[v0] Exchange connector factory v2.3.0 loaded")

// Perpetual-type equivalents that can be normalized between exchanges
const PERPETUAL_EQUIVALENTS = ["perpetual", "perpetual_futures", "perp", "swap"]

/**
 * Normalize API type to what the specific exchange supports.
 * Different exchanges use different names for the same thing:
 * - bingx uses "perpetual_futures" 
 * - pionex/orangex/gateio use "perpetual"
 * This function converts between them based on what the exchange accepts.
 */
function normalizeApiTypeForExchange(apiType: string, exchangeSupported: string[]): string {
  if (!exchangeSupported || !apiType) return apiType
  
  // If already supported, no change needed
  if (exchangeSupported.includes(apiType)) return apiType
  
  // Check if this is a perpetual-type that needs conversion
  if (PERPETUAL_EQUIVALENTS.includes(apiType)) {
    // Find which perpetual variant the exchange supports
    for (const variant of PERPETUAL_EQUIVALENTS) {
      if (exchangeSupported.includes(variant)) {
        return variant
      }
    }
  }
  
  return apiType
}

export async function createExchangeConnector(
  exchange: string,
  credentials: ExchangeCredentials
): Promise<BaseExchangeConnector> {
  const normalizedExchange = exchange.toLowerCase().replace(/[^a-z]/g, "")

  // Get supported types for this exchange
  const supported = EXCHANGE_API_TYPES[normalizedExchange]
  
  // Normalize API type based on what this specific exchange supports
  if (credentials.apiType && supported) {
    credentials.apiType = normalizeApiTypeForExchange(credentials.apiType, supported)
  }
  
  // Validate API type is supported for the exchange
  if (credentials.apiType && supported && !supported.includes(credentials.apiType)) {
    throw new Error(
      `Invalid API type '${credentials.apiType}' for ${exchange}. Supported: ${supported.join(", ")}`
    )
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
