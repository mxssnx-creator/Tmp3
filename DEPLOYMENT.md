# Deployment Guide

Complete instructions for deploying the Algorithmic Trading Engine to Vercel.

## Prerequisites

- Node.js 20+ 
- npm or yarn
- Vercel account (https://vercel.com)
- GitHub repository connected to Vercel
- Exchange API credentials (Bybit, BingX, OKX, etc.)

## Environment Variables Setup

### Required Variables

```bash
# Application Core
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://your-domain.vercel.app

# Security (generate 32+ character random strings)
JWT_SECRET=<your-32-char-jwt-secret>
SESSION_SECRET=<your-32-char-session-secret>
ENCRYPTION_KEY=<your-32-char-encryption-key>

# Redis/KV Store (Vercel KV recommended for production)
KV_REST_API_URL=https://your-redis.vercel.app
KV_REST_API_TOKEN=<your-redis-token>
```

### Exchange API Credentials

Add one or more exchange credentials:

```bash
# BingX (recommended for testing)
BINGX_API_KEY=<your-bingx-key>
BINGX_API_SECRET=<your-bingx-secret>
BINGX_TESTNET=false  # Set to true for paper trading

# Bybit
BYBIT_API_KEY=<your-bybit-key>
BYBIT_API_SECRET=<your-bybit-secret>
BYBIT_TESTNET=false

# Additional exchanges (optional)
OKX_API_KEY=<your-okx-key>
OKX_API_SECRET=<your-okx-secret>
OKX_PASSPHRASE=<your-okx-passphrase>
OKX_TESTNET=false

BINANCE_API_KEY=<your-binance-key>
BINANCE_API_SECRET=<your-binance-secret>
BINANCE_TESTNET=false
```

## Local Deployment Testing

### 1. Clone Repository

```bash
git clone https://github.com/your-repo.git
cd your-repo
npm install --legacy-peer-deps
```

### 2. Setup Local Environment

```bash
cp .env.example .env.local
# Edit .env.local with your credentials
```

### 3. Run Local Development

```bash
npm run dev
# Open http://localhost:3002
```

### 4. Test Database & Redis

```bash
# Check database status
curl http://localhost:3002/api/health/database

# Check system health
curl http://localhost:3002/api/health

# Initialize database (if needed)
curl -X POST http://localhost:3002/api/install/database/init
```

## Vercel Deployment

### 1. Connect GitHub Repository

1. Go to https://vercel.com
2. Click "Add New..." → "Project"
3. Import your GitHub repository
4. Select project root directory (or use default)

### 2. Configure Environment Variables

In Vercel Dashboard → Settings → Environment Variables:

```
1. Add all required environment variables from above
2. Scope: Production, Preview, Development (as appropriate)
3. Save changes
```

### 3. Configure Build Settings

**Build Command:** 
```
bash scripts/vercel-build-setup.sh
```

**Install Command:**
```
npm install --legacy-peer-deps
```

**Output Directory:** `.next`

### 4. Deploy

```bash
# Option A: Manual deployment via CLI
vercel --prod

# Option B: Automatic deployment
# Push to main/master branch - Vercel automatically deploys
git push origin main
```

### 5. Monitor Deployment

```bash
# Check deployment logs in Vercel Dashboard:
# Deployments → [Latest] → Logs

# Or via CLI:
vercel logs --prod
```

## Post-Deployment Verification

After deployment completes, verify all systems:

### 1. Run Verification Script

```bash
bash scripts/post-deploy-verify.sh
```

### 2. Manual Endpoint Checks

```bash
# Health endpoints
curl https://your-domain.vercel.app/api/health
curl https://your-domain.vercel.app/api/health/database

# Database status
curl https://your-domain.vercel.app/api/install/database/status

# Engine status
curl https://your-domain.vercel.app/api/trade-engine/status

# Settings
curl https://your-domain.vercel.app/api/settings
```

### 3. Access Dashboard

Open browser to: `https://your-domain.vercel.app/main`

Should display:
- ✓ Connection status
- ✓ Active strategies
- ✓ Live positions (if trading)
- ✓ Trade history
- ✓ System health

## Database Migrations

Migrations run automatically during deployment via `vercel-build-setup.sh`.

### Manual Migration Execution

If needed, manually trigger migrations:

```bash
# Check migration status
curl https://your-domain.vercel.app/api/admin/migrations/status

# Run migrations
curl -X POST https://your-domain.vercel.app/api/admin/run-migrations

# Reset database (CAUTION: Deletes all data)
curl -X POST https://your-domain.vercel.app/api/admin/reset-and-init
```

## Troubleshooting

### Build Fails with "Out of Memory"

The build script includes `--max-old-space-size=8192`. If still failing:

1. Check `vercel.json` `functions` memory is set to 3008+
2. Reduce bundle size by disabling features
3. Increase Vercel Pro plan limits

### Redis Connection Error

```
Error: KV_REST_API_URL not set
```

**Solution:**
1. Set up Vercel KV in Vercel dashboard
2. Environment variables should auto-populate
3. Redeploy after KV is created

### API Endpoints Returning 500

**Check logs:**
```bash
vercel logs --prod --follow
```

**Common causes:**
- Missing environment variables → Add to Vercel dashboard
- Redis initialization failed → Check database logs
- Function timeout → Increase `maxDuration` in `vercel.json`

### Cron Jobs Not Running

Verify in Vercel dashboard:
1. Settings → Cron Jobs should show both jobs
2. Check execution in Logs
3. Required: Production environment

## Performance Optimization

### 1. Redis Caching

The inline Redis implementation provides:
- In-memory data structure store
- Automatic TTL cleanup every 60 seconds
- Periodic disk snapshots every 5 minutes
- ~80K ops/sec throughput

For production high-traffic, use Vercel KV:
```bash
# Add to environment variables
KV_REST_API_URL=https://your-kv.vercel.app
KV_REST_API_TOKEN=<token>
```

### 2. Function Optimization

Current settings in `vercel.json`:
- Memory: 3008 MB
- Timeout: 300 seconds (5 minutes)
- Runtime: nodejs20.x

Adjust based on monitoring:

```json
{
  "functions": {
    "app/api/**/*.ts": {
      "memory": 3008,
      "maxDuration": 300
    }
  }
}
```

### 3. Static Asset Caching

Headers configured for:
- Static files: 1-year cache
- API: No cache (required for real-time data)
- Security headers: Enabled by default

## Rollback Procedure

### Revert to Previous Deployment

```bash
# List recent deployments
vercel list

# Rollback to specific deployment
vercel promote <deployment-id>
```

### Or via GitHub:

```bash
git revert <commit-hash>
git push origin main
# Vercel automatically redeploys
```

## Monitoring & Alerts

### 1. Setup Vercel Analytics

```
Vercel Dashboard → Settings → Analytics
Enable for performance monitoring
```

### 2. Health Check Monitoring

```bash
# Set up a cron to check health
curl -s https://your-domain.vercel.app/api/health | grep '"status":"healthy"'
```

### 3. Cron Job Monitoring

Both cron jobs run every minute/5 minutes. Monitor in:
- Vercel Dashboard → Cron Jobs
- Check logs for failures

## Production Best Practices

1. **Backup Keys:** Store JWT_SECRET, SESSION_SECRET, ENCRYPTION_KEY in secure vault
2. **API Key Rotation:** Rotate exchange API keys every 90 days
3. **Rate Limiting:** Implement in production (not in dev)
4. **Logging:** Enable structured logging in settings
5. **Monitoring:** Setup alerts for failed cron jobs
6. **Testing:** Test all strategies in paper-trading first
7. **Scaling:** Monitor Redis usage; upgrade if needed

## Support & Troubleshooting

For deployment issues:

1. Check Vercel logs: `vercel logs --prod`
2. Test locally first: `npm run dev`
3. Verify env vars are set correctly
4. Check GitHub actions for CI/CD failures
5. Review API health endpoints

## Next Steps

After successful deployment:

1. **Verify Connections** → Settings → Connections → Test
2. **Configure Strategies** → Settings → Strategies
3. **Set Risk Limits** → Settings → Risk Management
4. **Enable Paper Trading** → Live Trading → TESTNET mode
5. **Monitor Dashboard** → Real-time updates active

---

**Last Updated:** 2026-05-15  
**Version:** 1.0.0  
**Status:** Production Ready
