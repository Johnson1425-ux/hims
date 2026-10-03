import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/shell';

export default function DashboardLayout({ children }: { children: ReactNode }): ReactNode {
  return <AppShell>{children}</AppShell>;
}
