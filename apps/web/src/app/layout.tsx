import { headers } from 'next/headers';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import { ThemeProvider } from '@/lib/theme';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: {
    default: 'HIMS — Hospital Management System',
    template: '%s · HIMS',
  },
  description:
    'Multi-tenant hospital management: patient records, scheduling, clinical documentation, pharmacy and billing.',
  // A clinical system must never be indexed, and must not leak a patient id
  // through a referrer header to anything it links out to.
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Ward tablets are used one-handed and often with gloves; pinch-zoom has to
  // keep working, so maximumScale is deliberately not pinned.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f6fa' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1116' },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  // Set by src/middleware.ts, and present in production only: the development
  // policy allows inline scripts outright, because hot reloading injects some
  // that cannot be nonced. Reading a header makes every route dynamic, which
  // costs nothing here — every page is already no-store and session-scoped.
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Applies the stored theme before first paint. Without this a viewer
          who chose dark mode gets a white flash on every navigation — which on
          a ward at night is genuinely unpleasant.
        */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('hims.theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <SessionProvider>{children}</SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
