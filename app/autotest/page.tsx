import { TestDashboard } from '@/components/test-dashboard'

export const metadata = {
  title: 'Autotest & Debug',
  description: 'DRIFTUSDT Complete Progression Test Dashboard',
}

export default function TestPage() {
  return (
    <div className='min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900'>
      <div className='container mx-auto py-6'>
        <div className='mb-6'>
          <h1 className='text-3xl font-bold'>Autotest & Debug Dashboard</h1>
          <p className='text-muted-foreground mt-2'>
            Complete progression test for DRIFTUSDT engine with real-time metrics and debug controls
          </p>
        </div>

        <TestDashboard />

        <div className='mt-8 space-y-4'>
          <div className='grid md:grid-cols-2 gap-4'>
            <div className='bg-white dark:bg-slate-900 rounded-lg p-4 border'>
              <h3 className='font-bold mb-2'>Quick Start</h3>
              <ol className='text-sm space-y-2 text-muted-foreground'>
                <li>1. Click "Start Test" to begin the progression test</li>
                <li>2. Monitor real-time metrics for each phase</li>
                <li>3. Enable debug mode to see detailed logs</li>
                <li>4. Test completes after 60 seconds automatically</li>
              </ol>
            </div>

            <div className='bg-white dark:bg-slate-900 rounded-lg p-4 border'>
              <h3 className='font-bold mb-2'>Expected Results</h3>
              <div className='text-sm space-y-2 text-muted-foreground'>
                <p>✓ Cycles: 30+ (one per 2 seconds)</p>
                <p>✓ Indications: 30+ (one per cycle)</p>
                <p>✓ Strategies: 3,000+ (100+ per cycle)</p>
                <p>✓ Positions: 1-5 (live positions)</p>
              </div>
            </div>
          </div>

          <div className='bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-4'>
            <h3 className='font-bold mb-2 text-amber-900 dark:text-amber-100'>Debug Mode</h3>
            <p className='text-sm text-amber-800 dark:text-amber-200 mb-3'>
              Enable debug mode to see detailed execution flow, data transformations, and component interactions
            </p>
            <div className='text-xs font-mono text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-950 p-2 rounded'>
              Logs will show: [TIMESTAMP] [v0-DEBUG] [COMPONENT] message
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
