# Dev Debug Mode - Complete Reference

**Status**: ✅ ACTIVE AND READY
**Dev Server**: Running on http://localhost:3002
**Date**: May 13, 2026

---

## Quick Start (30 seconds)

1. **Open browser**: http://localhost:3002
2. **Press F12** to open DevTools
3. **Go to Console tab**
4. **Add to your code**: `console.log("[v0] Debug message")`
5. **Save file** - HMR reloads automatically
6. **See output** in Console tab

---

## Documentation Files

### DEBUG_MODE_QUICK_START.md ⭐ START HERE
- 3-step quick start guide
- One-line code examples
- Common issues & solutions
- Performance tips

### DEBUG_MODE_ACTIVE.md (Comprehensive)
- Complete debugging workflows
- Detailed examples for each scenario
- Browser DevTools guide
- Performance debugging section
- Troubleshooting guide
- Cleanup procedures

---

## Current Status

```
Dev Server:    ✅ Running (http://localhost:3002)
Port:          3002
HMR:           ✅ Active
Memory:        8GB allocated
Console:       ✅ Ready (F12)
Network Tab:   ✅ Ready (F12 → Network)
Build System:  ✅ Ready
```

---

## Key Features

- **Auto-Reload**: Edit file → Save → Auto-refresh (no manual reload)
- **Console Logging**: Use `[v0]` prefix for easy filtering
- **Network Monitoring**: Real-time API call tracking
- **DevTools**: Full browser inspection capabilities
- **Source Maps**: Debug original TypeScript/JSX code

---

## Debug Workflow

```
Add [v0] log
    ↓
Save file
    ↓
HMR reloads page
    ↓
See output in Console (F12)
    ↓
Remove log when done
```

---

## Example Debug Patterns

### Component Debugging
```typescript
console.log("[v0] Component mounted")
console.log("[v0] Rendering with data:", data)
```

### API Debugging
```typescript
console.log("[v0] API request:", request.body)
console.log("[v0] API response:", response)
```

### Database Debugging
```typescript
console.log("[v0] Storing position:", position)
console.log("[v0] Query result:", result)
```

### Timing Debugging
```typescript
const start = Date.now()
// ... operation ...
console.log("[v0] Took", Date.now() - start, 'ms')
```

---

## Browser DevTools

### Console Tab (F12 → Console)
- View all [v0] logs
- See errors and warnings
- Filter by [v0] prefix
- Execute console commands

### Network Tab (F12 → Network)
- Monitor API calls
- Check request/response
- View timing details
- See status codes

### Sources Tab (F12 → Sources)
- Set breakpoints
- Step through code
- Watch variables
- View call stack

### Application Tab (F12 → Application)
- View local storage
- Check cookies
- Inspect cache
- View session storage

---

## Useful Commands

```bash
# Check dev server
ps aux | grep "next dev"

# Find all debug logs
grep -r "[v0]" app/ lib/ components/

# Restart dev server
pkill -f "next dev"
npm run dev

# Test API endpoint
curl http://localhost:3002/api/example
```

---

## Cleanup After Debugging

1. Remove all [v0] debug logs
   ```bash
   grep -r "\[v0\]" app/ lib/ components/
   ```

2. Check console has no errors
   - Open DevTools (F12)
   - Console tab should be clean

3. Test application
   - Navigate all pages
   - Verify features work

4. Commit clean code
   - No [v0] logs
   - All tests passing

---

## Troubleshooting

**Changes not appearing?**
- Check terminal for compilation errors
- Hard refresh: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)
- Check DevTools Network tab

**Debug logs not showing?**
- Check DevTools is open (F12)
- Check you're in Console tab
- Clear any filters or search

**API calls failing?**
- Check Network tab for response
- Add [v0] logs to API route
- Check server terminal for errors

**HMR not working?**
- Check terminal for build errors
- Restart dev server manually
- Clear browser cache

---

## Performance Tips

- Use [v0] logs near the problem area
- Check Console for [v0] output (fast)
- Use Network tab to profile API calls
- Use Sources tab to debug specific functions
- HMR is fast - no manual refresh needed

---

## Remember

✓ Use [v0] prefix for debug logs
✓ Press F12 to open DevTools
✓ Console tab shows [v0] logs
✓ Network tab shows API calls
✓ Save file → HMR auto-reloads
✓ Remove logs when debugging done

---

## You're Ready!

Everything is set up. Start debugging now:

1. Go to http://localhost:3002
2. Press F12
3. Add [v0] logs to your code
4. Save and watch HMR reload
5. See output in console

Happy debugging! 🚀

