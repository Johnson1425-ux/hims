'use client';

/**
 * Module scaffold.
 *
 * Used by the screens whose API endpoints exist and are tested but whose UI is
 * not built yet. It states plainly what the backend already does, so the gap
 * is legible rather than looking like a broken page — and lists the endpoints,
 * so the next person picking it up knows where to start.
 */
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/layout/shell';
import { Alert, Card, CardHeader } from '@/components/ui/primitives';

export function ModuleScaffold({
  title,
  subtitle,
  summary,
  endpoints,
  icon,
}: {
  title: string;
  subtitle: string;
  summary: string;
  endpoints: Array<{ method: string; path: string; note: string }>;
  icon?: ReactNode;
}): ReactNode {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />

      <div className="mb-5">
        <Alert tone="info" title="API complete, interface pending">
          {summary}
        </Alert>
      </div>

      <Card>
        <CardHeader
          title="Endpoints backing this screen"
          subtitle="Implemented, permission-gated and covered by the invariant suite"
          action={icon}
        />
        <ul className="flex flex-col gap-2">
          {endpoints.map((endpoint) => (
            <li
              key={`${endpoint.method} ${endpoint.path}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[var(--radius-md)] p-3"
              style={{ background: 'var(--surface-sunken)' }}
            >
              <code
                className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[0.6875rem] font-semibold"
                style={{ background: 'var(--accent-soft)', color: 'var(--info-ink)' }}
              >
                {endpoint.method}
              </code>
              <code className="text-[0.8125rem]" style={{ color: 'var(--ink)' }}>
                {endpoint.path}
              </code>
              <span className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                {endpoint.note}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
