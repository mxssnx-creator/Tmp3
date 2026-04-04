import type { Metadata } from "next"
import "@/app/globals.css"
import { Providers } from "@/components/providers"

export const metadata: Metadata = {
  title: "CTS v3.2 Dashboard",
  description: "Crypto Trading System Dashboard",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  )
}
