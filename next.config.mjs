// Force rebuild: 2026-04-10T13:07:30
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
  webpack: (config, { isServer, nextRuntime }) => {
    config.resolve = config.resolve || {}

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
