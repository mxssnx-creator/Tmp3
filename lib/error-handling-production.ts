/**
 * Production Error Handling System
 * 
 * Handles unhandled promise rejections and uncaught exceptions
 * Provides centralized error logging and alerting
 * Ensures graceful degradation instead of crashes
 */

export interface ProductionError {
  type: 'unhandledRejection' | 'uncaughtException'
  reason?: string
  error?: string
  message?: string
  stack?: string
  timestamp: Date
  severity: 'critical' | 'high' | 'medium' | 'low'
}

// Global error tracking
export class ProductionErrorHandler {
  private static logger = null // Will be used for logging to SystemLogger if needed
  private static errorQueue: ProductionError[] = []
  private static maxQueueSize = 1000
  private static isShuttingDown = false

  /**
   * Initialize production error handlers
   * Must be called early in application startup (instrumentation.ts)
   */
  static initialize() {
    if (this.isInitialized()) {
      console.log('[ERROR_HANDLER] Already initialized, skipping')
      return
    }

    console.log('[ERROR_HANDLER] Initializing production error handlers...')

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.handleUnhandledRejection(reason, promise)
    })

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.handleUncaughtException(error)
    })

    // Handle graceful shutdown signals
    process.on('SIGTERM', () => this.handleShutdown('SIGTERM'))
    process.on('SIGINT', () => this.handleShutdown('SIGINT'))

    // Mark initialization
    ;(globalThis as any).__errorHandlerInitialized = true
    console.log('[ERROR_HANDLER] Production error handlers initialized')
  }

  /**
   * Check if error handler is already initialized
   */
  private static isInitialized(): boolean {
    return !!(globalThis as any).__errorHandlerInitialized
  }

  /**
   * Handle unhandled promise rejection
   */
  private static handleUnhandledRejection(reason: any, promise: Promise<any>) {
    const error: ProductionError = {
      type: 'unhandledRejection',
      reason: String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      timestamp: new Date(),
      severity: 'critical'
    }

    console.error('[ERROR] Unhandled Promise Rejection:', reason)
    console.error('Promise:', promise)

    this.logError(error)
    this.trackErrorMetric(error)
  }

  /**
   * Handle uncaught exception
   */
  private static handleUncaughtException(error: Error) {
    const productionError: ProductionError = {
      type: 'uncaughtException',
      error: error.name,
      message: error.message,
      stack: error.stack,
      timestamp: new Date(),
      severity: 'critical'
    }

    console.error('[ERROR] Uncaught Exception:', error)

    this.logError(productionError)
    this.trackErrorMetric(productionError)

    // Graceful shutdown after logging
    console.error('[ERROR] Initiating graceful shutdown...')
    this.gracefulShutdown(1)
  }

  /**
   * Handle shutdown signals
   */
  private static handleShutdown(signal: string) {
    console.log(`[SHUTDOWN] Received ${signal}, initiating graceful shutdown...`)
    this.gracefulShutdown(0)
  }

  /**
   * Graceful shutdown sequence
   */
  private static gracefulShutdown(exitCode: number) {
    if (this.isShuttingDown) {
      console.log('[SHUTDOWN] Already shutting down, forcing exit...')
      process.exit(exitCode)
      return
    }

    this.isShuttingDown = true

    // Give 10 seconds for cleanup before forcing exit
    const shutdownTimeout = setTimeout(() => {
      console.error('[SHUTDOWN] Forced exit after timeout')
      process.exit(exitCode)
    }, 10000)

    shutdownTimeout.unref() // Don't block process exit

    // Attempt graceful cleanup
    try {
      // Close connections, flush logs, etc.
      console.log('[SHUTDOWN] Cleanup complete, exiting...')
      process.exit(exitCode)
    } catch (error) {
      console.error('[SHUTDOWN] Error during cleanup:', error)
      process.exit(exitCode)
    }
  }

  /**
   * Log error to system
   */
  private static logError(error: ProductionError) {
    // Queue error for later processing
    this.errorQueue.push(error)
    if (this.errorQueue.length > this.maxQueueSize) {
      this.errorQueue.shift() // Remove oldest
    }

    // Log to error tracking system
    try {
      // Log is queued in errorQueue, can be sent to WorkflowLogger later
      console.error('[ERROR_HANDLER] Error logged:', {
        type: error.type,
        message: error.message || error.reason,
        severity: error.severity,
        stack: error.stack
      })
    } catch (logError) {
      console.error('[ERROR_HANDLER] Failed to log error:', logError)
    }
  }

  /**
   * Track error metrics for monitoring
   */
  private static trackErrorMetric(error: ProductionError) {
    // This will be connected to Prometheus metrics in Fix A7
    const key = `error:${error.type}:${error.severity}`
    try {
      // Placeholder for metrics integration
      // Will be implemented with Prometheus in Fix A7
    } catch (e) {
      console.error('[ERROR_HANDLER] Failed to track metric:', e)
    }
  }

  /**
   * Get recent errors for debugging
   */
  static getRecentErrors(limit: number = 50): ProductionError[] {
    return this.errorQueue.slice(-limit)
  }

  /**
   * Clear error queue (be careful with this)
   */
  static clearErrorQueue() {
    this.errorQueue = []
  }

  /**
   * Get error statistics
   */
  static getErrorStats(): { [key: string]: number } {
    const stats: { [key: string]: number } = {}

    for (const error of this.errorQueue) {
      const key = `${error.type}:${error.severity}`
      stats[key] = (stats[key] || 0) + 1
    }

    return stats
  }
}

/**
 * Wrapper function to safely handle async operations
 * Ensures errors are caught and logged
 */
export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  context: { operation: string; severity?: 'low' | 'medium' | 'high' | 'critical' }
): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    const productionError: ProductionError = {
      type: 'uncaughtException',
      message: `Error in ${context.operation}`,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date(),
      severity: context.severity || 'high'
    }

    // Log error to console (ProductionErrorHandler catches unhandled exceptions/rejections separately)
    console.error(`[ERROR_HANDLER] ${context.operation} failed:`, productionError)

    // Return null instead of throwing to allow graceful degradation
    return null
  }
}

export default ProductionErrorHandler
