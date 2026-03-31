import type { Metadata } from "next"
// @ts-expect-error CSS import not typed
import "@/app/globals.css"
import { Providers } from "@/components/providers"

export const metadata: Metadata = {
  title: "CTS v3.2 Dashboard",
  description: "Crypto Trading System Dashboard",
}

export const dynamic = "force-dynamic"

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans">
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  )
}
