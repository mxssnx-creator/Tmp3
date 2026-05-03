// Force rebuild: 2026-05-03T16:30:00 — Bybit/BingX auto-active on bootstrap, configurable per-Set entry cap, ExecPos + AvgPF tiles, global engine cold-boot

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    serverActions: {
      allowedOrigins: ["*"],
    },
  },
  // Next.js passes its own bundled `webpack` instance as the second
  // argument here. We DON'T `import "webpack"` at the top of this file
  // because `webpack` isn't a direct dependency of the project and
  // Node's ESM loader will throw `ERR_MODULE_NOT_FOUND` (observed in
  // dev logs at 2026-04-28T10:08:20).
  webpack: (config, { isServer, nextRuntime, webpack }) => {
    config.resolve = config.resolve || {}
    config.plugins = config.plugins || []

    // ── Strip the `node:` URI scheme from every dynamic/static import ──
    //
    // Webpack 5's default scheme handler does NOT recognise `node:`, so a
    // call like `await import("node:fs/promises")` raises
    // `UnhandledSchemeError` during the BUILD pass — even when the call
    // is gated by a runtime guard like
    // `if (typeof process === "undefined" || !process.versions?.node)`.
    // The error originates BEFORE alias resolution, so simply aliasing
    // `node:fs/promises → false` is not sufficient (we tried — see the
    // `nodeBuiltinsToStub` block below).
    //
    // `NormalModuleReplacementPlugin` runs in the resolve pipeline
    // BEFORE the scheme handler. Rewriting `node:fs/promises → fs/promises`
    // here means:
    //   • Server (nodejs runtime): bare specifier resolves natively.
    //   • Edge runtime: bare specifier resolves to `false` via the alias
    //     map below.
    //   • Browser: bare specifier resolves to `false` via the fallback
    //     map below.
    // This single plugin invocation is the safe, runtime-agnostic fix.
    //
    // Persistent dependency graphs from Webpack's filesystem cache
    // (`.next/cache`) are also healed because the replacement runs on
    // every build, not just on cold compiles — stale cache entries
    // referencing `node:` URIs get rewritten on the next module touch.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, "")
      }),
    )

    // Browser bundle: Node built-ins are unavailable. Alias them to empty
    // stubs so any transitively-imported server lib still type-checks and
    // compiles for the client (its code paths are guarded at runtime).
    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        crypto: false,
        stream: false,
        buffer: false,
      }
    }

    // Edge runtime bundle: Next.js compiles `instrumentation.ts` for BOTH
    // `nodejs` and `edge` runtimes. Even though the function body is
    // guarded with `if (process.env.NEXT_RUNTIME !== "nodejs") return`,
    // Webpack still walks the static + dynamic-import graph for the Edge
    // target — which transitively reaches `lib/exchange-connectors/*`,
    // `lib/preset-coordination-engine.ts`, `lib/exchanges.ts`, and
    // `lib/security-hardening.ts`, every one of which imports `crypto`.
    //
    // Webpack 5 does not handle `node:` URI schemes in the Edge target
    // and the bare `crypto` specifier resolves to nothing on Edge,
    // producing the `Module not found: Can't resolve 'crypto'` error
    // observed in the dev logs. The fix is to alias the offending Node
    // built-ins to `false` (an empty stub) for the Edge build only —
    // the runtime guard in `instrumentation.ts` ensures the stub is
    // never executed when a real request arrives.
    if (nextRuntime === "edge") {
      // Stub every Node built-in that any transitively-imported server lib
      // touches. This list mirrors the Node-only modules actually referenced
      // anywhere downstream of `instrumentation.ts`:
      //
      //   • crypto       — exchange connectors (HMAC signing)
      //   • fs / path    — `lib/redis-db.ts` snapshot persistence
      //                    (also `lib/env-credentials.ts`)
      //   • stream       — body parsing helpers
      //   • buffer       — encoding helpers
      //   • events       — used by some legacy logging pieces
      //   • timers/promises — `setTimeout`/`setImmediate` await-friendly API
      //
      // Each is also listed under both the bare specifier (`fs`) and the
      // `node:` URI form (`node:fs`) because `lib/redis-db.ts` uses the URI
      // form via dynamic `await import("node:fs/promises")` etc. Webpack 5
      // does not handle `node:` URIs natively in the Edge target, hence
      // the explicit aliases.
      const nodeBuiltinsToStub = [
        "crypto",
        "fs",
        "fs/promises",
        "path",
        "stream",
        "buffer",
        "events",
        "timers",
        "timers/promises",
        "os",
        "url",
        "util",
        "zlib",
      ]
      const stubAliases = {}
      for (const name of nodeBuiltinsToStub) {
        stubAliases[name] = false
        stubAliases[`node:${name}`] = false
      }
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        ...stubAliases,
      }
    }

    return config
  },
}

export default nextConfig
