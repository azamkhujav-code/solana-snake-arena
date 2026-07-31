import type { Metadata, Viewport } from 'next';

import { Providers } from './providers';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Slither Arena',
    template: '%s · Slither Arena',
  },
  description: 'Multiplayer snake arena on Solana.',
  applicationName: 'Slither Arena',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#0b1120',
  width: 'device-width',
  initialScale: 1,
  // The game canvas handles its own zoom; browser pinch-zoom breaks aiming.
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
