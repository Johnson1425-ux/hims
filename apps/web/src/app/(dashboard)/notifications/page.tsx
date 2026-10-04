'use client';

/**
 * Notifications.
 *
 * Scoped to the signed-in user, always. A critical-result alert names a
 * patient; showing it to everyone who happens to hold the same permission
 * would widen the circle of people who know that named patient has an
 * abnormal result, which is the opposite of what the alert is for.
 *
 * Unread sorts first, then by priority — a critical result outranks a stock
 * alert however much later the stock alert arrived.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/shell';
import { Alert, Badge, Button, Card, EmptyState, Skeleton, type Tone } from '@/components/ui/primitives';
import { api, ApiError, type AppNotification } from '@/lib/api';
import { formatDateTime, formatRelative, humanise, pluralise } from '@/lib/format';
import { IconBell } from '@/components/layout/icons';

const CATEGORY_TONE: Record<string, Tone> = {
  clinical: 'critical',
  security: 'serious',
  inventory: 'warning',
  billing: 'info',
  appointment: 'info',
  operational: 'neutral',
  marketing: 'neutral',
};

/** Where a notification is actually actionable, if anywhere. */
function destination(item: AppNotification): string | null {
  if (item.related_kind === 'patient' && item.related_id) return `/patients/${item.related_id}`;
  if (item.related_kind === 'encounter' && item.related_id) return `/clinical/${item.related_id}`;
  if (item.related_kind === 'invoice' && item.related_id) return `/billing/${item.related_id}`;
  if (item.category === 'inventory') return '/inventory';
  return null;
}

export default function NotificationsPage() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);

    try {
      const { data } = await api.get<AppNotification[]>('/notifications', { limit: 100 }, signal);
      setItems(data);
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function markRead(id: string): Promise<void> {
    await api.post(`/notifications/${id}/read`, {}).catch(() => undefined);
    await load();
  }

  async function markAllRead(): Promise<void> {
    setBusy(true);
    try {
      await api.post('/notifications/read-all', {});
      await load();
    } finally {
      setBusy(false);
    }
  }

  const unread = items.filter((item) => item.read_at === null);

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={
          loading
            ? 'Loading…'
            : unread.length === 0
              ? 'Nothing unread'
              : `${pluralise(unread.length, 'unread notification')}`
        }
        actions={
          unread.length > 0 ? (
            <Button variant="secondary" loading={busy} onClick={() => void markAllRead()}>
              Mark all as read
            </Button>
          ) : null
        }
      />

      {error ? (
        <div className="mb-5">
          <Alert tone="critical" title="Could not load notifications">
            {error}
          </Alert>
        </div>
      ) : null}

      <Card padded={false}>
        {loading && items.length === 0 ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={56} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<IconBell />}
            title="Nothing here"
            description="Critical results, stock alerts and account notices addressed to you appear here."
          />
        ) : (
          <ul className="flex flex-col">
            {items.map((item) => {
              const href = destination(item);
              const unreadItem = item.read_at === null;

              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
                  style={{
                    borderTop: '1px solid var(--line)',
                    background: unreadItem ? 'var(--surface-sunken)' : undefined,
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={CATEGORY_TONE[item.category] ?? 'neutral'} dot={!unreadItem}>
                        {humanise(item.category)}
                      </Badge>
                      <span
                        className="font-medium"
                        style={{ color: unreadItem ? 'var(--ink)' : 'var(--ink-secondary)' }}
                      >
                        {item.subject ?? 'Notification'}
                      </span>
                      {item.priority <= 2 ? <Badge tone="critical">Urgent</Badge> : null}
                    </span>

                    {item.body ? (
                      <p className="mt-1 text-[0.875rem]" style={{ color: 'var(--ink-secondary)' }}>
                        {item.body}
                      </p>
                    ) : null}

                    <p className="mt-1 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                      <span title={formatDateTime(item.created_at)}>{formatRelative(item.created_at)}</span>
                      {item.read_at ? ` · read ${formatRelative(item.read_at)}` : ''}
                    </p>
                  </div>

                  <span className="flex shrink-0 items-center gap-1.5">
                    {href ? (
                      <Link href={href}>
                        <Button size="sm" variant="secondary" onClick={() => void markRead(item.id)}>
                          Open
                        </Button>
                      </Link>
                    ) : null}
                    {unreadItem ? (
                      <Button size="sm" variant="ghost" onClick={() => void markRead(item.id)}>
                        Mark read
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
