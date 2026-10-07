import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PlatformSessionProvider } from '@/lib/platform-session';

export const metadata: Metadata = {
  title: 'Platform console',
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The console's own session, held apart from the hospital one.
 *
 * `SessionProvider` from the root layout is still mounted above this — it
 * finds no hospital session and settles on 'anonymous', which is correct.
 * The two never share a token, a cookie or a provider.
 */
export default function PlatformLayout({ children }: { children: ReactNode }): ReactNode {
  return <PlatformSessionProvider>{children}</PlatformSessionProvider>;
}
