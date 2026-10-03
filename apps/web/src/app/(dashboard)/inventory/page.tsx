'use client';

/**
 * Stock control.
 *
 * The table is sorted by URGENCY, not alphabetically: out of stock first, then
 * critical, then low. A pharmacy manager opening this screen wants the problems,
 * and an alphabetical list buries them.
 *
 * Each row carries a meter with the reorder level marked on the track, so "how
 * close to running out" is visible rather than inferred from two numbers.
 */
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/layout/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Meter,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
  type Tone,
} from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import { api, ApiError, type StockStatusItem } from '@/lib/api';
import { formatDate, formatNumber, humanise } from '@/lib/format';
import { IconBox, IconSearch } from '@/components/layout/icons';

const STATE_TONE: Record<StockStatusItem['stockState'], Tone> = {
  out_of_stock: 'critical',
  critical: 'critical',
  low: 'warning',
  overstocked: 'info',
  ok: 'good',
};

type StateFilter = 'all' | 'attention' | StockStatusItem['stockState'];

export default function InventoryPage() {
  const { can } = useSession();
  const [items, setItems] = useState<StockStatusItem[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StateFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);

      try {
        const { data, meta } = await api.get<StockStatusItem[]>(
          '/inventory/stock',
          {
            q: query.trim() || undefined,
            state: filter !== 'all' && filter !== 'attention' ? filter : undefined,
            pageSize: 200,
          },
          signal,
        );

        setItems(
          filter === 'attention' ? data.filter((item) => item.stockState !== 'ok') : data,
        );
        setSummary((meta?.summary as Record<string, number>) ?? {});
      } catch (caught) {
        if (caught instanceof ApiError) setError(caught.message);
      } finally {
        setLoading(false);
      }
    },
    [query, filter],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [load]);

  const needsAttention =
    (summary.out_of_stock ?? 0) + (summary.critical ?? 0) + (summary.low ?? 0);

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Medication and consumable stock across every store"
        actions={
          can('inventory:write') ? (
            <>
              <Button variant="secondary">Adjust stock</Button>
              <Button variant="primary">Receive goods</Button>
            </>
          ) : null
        }
      />

      {needsAttention > 0 ? (
        <div className="mb-5">
          <Alert
            tone={(summary.out_of_stock ?? 0) + (summary.critical ?? 0) > 0 ? 'critical' : 'warning'}
            title={`${needsAttention} item(s) at or below their reorder level`}
            action={
              <Button size="sm" variant="secondary" onClick={() => setFilter('attention')}>
                Show only these
              </Button>
            }
          >
            Low-stock alerts notify once per item and location, and clear automatically when stock
            is received.
          </Alert>
        </div>
      ) : null}

      <section aria-label="Stock summary" className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Out of stock"
          value={formatNumber(summary.out_of_stock ?? 0)}
          tone={(summary.out_of_stock ?? 0) > 0 ? 'critical' : 'good'}
        />
        <StatTile
          label="Critical"
          value={formatNumber(summary.critical ?? 0)}
          tone={(summary.critical ?? 0) > 0 ? 'critical' : 'good'}
        />
        <StatTile
          label="Low"
          value={formatNumber(summary.low ?? 0)}
          tone={(summary.low ?? 0) > 0 ? 'warning' : 'good'}
        />
        <StatTile label="In good order" value={formatNumber(summary.ok ?? 0)} tone="good" />
      </section>

      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 p-4" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="min-w-[14rem] flex-1">
            <Input
              name="stock-search"
              label="Find an item"
              placeholder="Name or SKU"
              leading={<IconSearch className="h-4 w-4" />}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div>
            <label
              htmlFor="state-filter"
              className="mb-1.5 block text-[0.8125rem] font-medium"
              style={{ color: 'var(--ink-secondary)' }}
            >
              Stock state
            </label>
            <select
              id="state-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value as StateFilter)}
              className="h-9.5 rounded-[var(--radius-md)] px-3 text-[0.875rem]"
              style={{
                background: 'var(--surface)',
                color: 'var(--ink)',
                border: '1px solid var(--line-strong)',
              }}
            >
              <option value="all">All items</option>
              <option value="attention">Needs attention</option>
              <option value="out_of_stock">Out of stock</option>
              <option value="critical">Critical</option>
              <option value="low">Low</option>
              <option value="ok">In good order</option>
            </select>
          </div>
        </div>

        {error ? (
          <div className="p-4">
            <p className="text-[0.875rem]" style={{ color: 'var(--critical-ink)' }}>
              {error}
            </p>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={48} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<IconBox />} title="No items match these filters" />
        ) : (
          <div className="px-5 pb-1">
            <Table>
              <thead>
                <tr>
                  <Th>Item</Th>
                  <Th>Location</Th>
                  <Th width="11rem">Level</Th>
                  <Th align="right">Available</Th>
                  <Th align="right">Reorder at</Th>
                  <Th align="right">Cover</Th>
                  <Th align="right">Earliest expiry</Th>
                  <Th align="right" width="8rem">
                    State
                  </Th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const expiringSoon =
                    item.earliestExpiry !== null &&
                    new Date(item.earliestExpiry).getTime() - Date.now() < 60 * 86_400_000;

                  return (
                    <Tr key={`${item.itemId}-${item.locationId}`}>
                      <Td>
                        <span className="block font-medium" style={{ color: 'var(--ink)' }}>
                          {item.name}
                        </span>
                        <span className="flex items-center gap-1.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                          <span className="tabular">{item.sku}</span>
                          {item.controlledSchedule ? (
                            <Badge tone="serious">Schedule {item.controlledSchedule}</Badge>
                          ) : null}
                        </span>
                      </Td>
                      <Td style={{ color: 'var(--ink-muted)' }}>{item.locationName}</Td>
                      <Td>
                        <Meter
                          value={item.quantityAvailable}
                          max={Math.max(item.reorderLevel * 2, item.quantityAvailable, 1)}
                          threshold={item.reorderLevel}
                          tone={STATE_TONE[item.stockState]}
                          label={`${item.name} level`}
                        />
                      </Td>
                      <Td numeric align="right" className="font-medium">
                        {formatNumber(item.quantityAvailable)}
                        <span className="ml-1 text-[0.75rem] font-normal" style={{ color: 'var(--ink-muted)' }}>
                          {item.baseUnit}
                        </span>
                      </Td>
                      <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                        {formatNumber(item.reorderLevel)}
                      </Td>
                      <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                        {item.daysOfCover !== null ? `${item.daysOfCover}d` : '—'}
                      </Td>
                      <Td numeric align="right">
                        {item.earliestExpiry ? (
                          <span style={{ color: expiringSoon ? 'var(--serious-ink)' : 'var(--ink-muted)' }}>
                            {formatDate(item.earliestExpiry)}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--ink-muted)' }}>—</span>
                        )}
                      </Td>
                      <Td align="right">
                        <Badge tone={STATE_TONE[item.stockState]}>{humanise(item.stockState)}</Badge>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
