import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/shell';
import { TenantProvider } from '@/lib/tenant';

/**
 * The tenant is fetched here rather than per screen: four of them need the
 * facility and department lists to render a filter, and the hospital's
 * currency and locale have to be applied before the first amount is drawn.
 */
export default function DashboardLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <TenantProvider>
      <AppShell>{children}</AppShell>
    </TenantProvider>
  );
}
