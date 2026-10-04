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
import {
  api,
  ApiError,
  type FormularyItem,
  type InventoryLocation,
  type StockAlert,
  type StockStatusItem,
} from '@/lib/api';
import { Checkbox, Field, FormDialog, Select, TextArea, useFormErrors } from '@/components/ui/forms';
import { Badge as Chip, CardHeader, Card as Panel } from '@/components/ui/primitives';
import { formatDate, formatNumber, formatRelative, humanise, pluralise } from '@/lib/format';
import { IconBox, IconSearch } from '@/components/layout/icons';

const STATE_TONE: Record<StockStatusItem['stockState'], Tone> = {
  out_of_stock: 'critical',
  critical: 'critical',
  low: 'warning',
  overstocked: 'info',
  ok: 'good',
};

type StateFilter = 'all' | 'attention' | StockStatusItem['stockState'];

/** Shared by both dialogs: neither can act on an item that is not in the book. */
function ItemChooser({
  chosen,
  onChoose,
  search,
  onSearch,
  results,
}: {
  chosen: FormularyItem | null;
  onChoose: (item: FormularyItem | null) => void;
  search: string;
  onSearch: (value: string) => void;
  results: FormularyItem[];
}) {
  if (chosen) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] p-3"
        style={{ background: 'var(--surface-sunken)', border: '1px solid var(--line)' }}
      >
        <span className="min-w-0">
          <span className="block truncate font-medium" style={{ color: 'var(--ink)' }}>
            {chosen.name}
          </span>
          <span className="tabular text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
            {chosen.sku} · {formatNumber(Number(chosen.quantity_on_hand))} {chosen.base_unit} on hand
          </span>
        </span>
        <button
          type="button"
          onClick={() => onChoose(null)}
          className="shrink-0 text-[0.8125rem] font-medium"
          style={{ color: 'var(--accent)' }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        name="itemSearch"
        label="Item"
        autoComplete="off"
        placeholder="Name or SKU"
        leading={<IconSearch className="h-4 w-4" />}
        value={search}
        onChange={(event) => onSearch(event.target.value)}
      />
      {results.length > 0 ? (
        <ul
          className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-[var(--radius-md)]"
          style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
        >
          {results.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onChoose(item)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                style={{ borderBottom: '1px solid var(--line)' }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[0.875rem]" style={{ color: 'var(--ink)' }}>
                    {item.name}
                  </span>
                  <span className="tabular text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                    {item.sku} · {formatNumber(Number(item.quantity_on_hand))} {item.base_unit}
                  </span>
                </span>
                {item.controlled_schedule ? <Chip tone="serious">Sch {item.controlled_schedule}</Chip> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function InventoryPage() {
  const { can } = useSession();
  const [items, setItems] = useState<StockStatusItem[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StateFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [alerts, setAlerts] = useState<StockAlert[]>([]);
  const [notice, setNotice] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);
  const [busyAlert, setBusyAlert] = useState<string | null>(null);

  const [receiving, setReceiving] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [medSearch, setMedSearch] = useState('');
  const [medResults, setMedResults] = useState<FormularyItem[]>([]);
  const [chosenItem, setChosenItem] = useState<FormularyItem | null>(null);
  const [receipt, setReceipt] = useState({
    locationId: '',
    lotNumber: '',
    quantity: '',
    unitCostCents: '',
    expiresOn: '',
  });
  const [adjustment, setAdjustment] = useState({
    locationId: '',
    quantity: '',
    movementType: 'wastage',
    reason: '',
  });

  const receiveForm = useFormErrors();
  const adjustForm = useFormErrors();

  const loadSidecar = useCallback(async (signal?: AbortSignal) => {
    const [locationResult, alertResult] = await Promise.all([
      api.get<InventoryLocation[]>('/inventory/locations', undefined, signal).catch(() => ({ data: [] })),
      api.get<StockAlert[]>('/inventory/alerts', { status: 'open' }, signal).catch(() => ({ data: [] })),
    ]);
    setLocations(locationResult.data);
    setAlerts(alertResult.data);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSidecar(controller.signal);
    return () => controller.abort();
  }, [loadSidecar]);

  // The formulary search is shared by both dialogs: receiving and adjusting
  // both act on an item, and neither can act on one that is not in the book.
  useEffect(() => {
    if (medSearch.trim().length < 2) {
      setMedResults([]);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api
        .get<FormularyItem[]>('/inventory/items', { q: medSearch.trim(), limit: 8 }, controller.signal)
        .then(({ data }) => setMedResults(data))
        .catch(() => undefined);
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [medSearch]);

  async function receiveGoods(): Promise<void> {
    if (!chosenItem) return;
    receiveForm.reset();

    try {
      await api.post('/inventory/stock/receive', {
        itemId: chosenItem.id,
        locationId: receipt.locationId,
        lotNumber: receipt.lotNumber,
        quantity: Number(receipt.quantity),
        unitCostCents: Number(receipt.unitCostCents || 0),
        expiresOn: receipt.expiresOn || undefined,
      });

      setNotice({
        tone: 'good',
        text: `${receipt.quantity} ${chosenItem.base_unit} of ${chosenItem.name} received into stock.`,
      });
      setReceiving(false);
      setChosenItem(null);
      setMedSearch('');
      setReceipt({ locationId: '', lotNumber: '', quantity: '', unitCostCents: '', expiresOn: '' });
      await Promise.all([load(), loadSidecar()]);
    } catch (caught) {
      receiveForm.capture(caught);
    }
  }

  async function adjustStock(): Promise<void> {
    if (!chosenItem) return;
    adjustForm.reset();

    try {
      await api.post('/inventory/stock/adjust', {
        itemId: chosenItem.id,
        locationId: adjustment.locationId,
        // Wastage, expiry and recall remove stock; a stock take or a return
        // can go either way, so the sign is the operator's to state.
        quantity: ['wastage', 'expiry', 'recall'].includes(adjustment.movementType)
          ? -Math.abs(Number(adjustment.quantity))
          : Number(adjustment.quantity),
        movementType: adjustment.movementType,
        reason: adjustment.reason,
      });

      setNotice({ tone: 'good', text: `${chosenItem.name} adjusted and written to the ledger.` });
      setAdjusting(false);
      setChosenItem(null);
      setMedSearch('');
      setAdjustment({ locationId: '', quantity: '', movementType: 'wastage', reason: '' });
      await Promise.all([load(), loadSidecar()]);
    } catch (caught) {
      adjustForm.capture(caught);
    }
  }

  async function actOnAlert(alert: StockAlert, action: string): Promise<void> {
    setBusyAlert(alert.id);

    try {
      await api.patch(`/inventory/alerts/${alert.id}`, { action });
      await loadSidecar();
    } catch (caught) {
      setNotice({
        tone: 'critical',
        text: caught instanceof ApiError ? caught.message : 'The alert could not be updated.',
      });
    } finally {
      setBusyAlert(null);
    }
  }

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
              <Button
                variant="secondary"
                onClick={() => {
                  setChosenItem(null);
                  setMedSearch('');
                  adjustForm.reset();
                  setAdjusting(true);
                }}
              >
                Adjust stock
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setChosenItem(null);
                  setMedSearch('');
                  receiveForm.reset();
                  setReceiving(true);
                }}
              >
                Receive goods
              </Button>
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

      {notice ? (
        <div className="mb-5">
          <Alert tone={notice.tone} title={notice.tone === 'good' ? 'Done' : 'Not done'}>
            {notice.text}
          </Alert>
        </div>
      ) : null}

      {alerts.length > 0 ? (
        <div className="mb-5">
          <Panel padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title={`${pluralise(alerts.length, 'open alert')}`}
                subtitle="Raised once per item and location when stock crosses its threshold — acting on one closes it"
              />
            </div>
            <ul className="flex flex-col">
              {alerts.map((alert) => (
                <li
                  key={alert.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-5 py-3"
                  style={{ borderTop: '1px solid var(--line)' }}
                >
                  <div className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Chip tone={alert.severity === 'critical' ? 'critical' : 'warning'}>
                        {humanise(alert.alert_type)}
                      </Chip>
                      <span className="font-medium" style={{ color: 'var(--ink)' }}>
                        {alert.item_name}
                      </span>
                      <span className="tabular text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                        {alert.sku} · {alert.location_name}
                      </span>
                    </span>
                    <p className="mt-1 text-[0.8125rem]" style={{ color: 'var(--ink-secondary)' }}>
                      {alert.message}
                    </p>
                    <p className="mt-0.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                      Raised {formatRelative(alert.created_at)}
                      {alert.preferred_supplier ? ` · usual supplier ${alert.preferred_supplier}` : ''}
                    </p>
                  </div>

                  {can('inventory:write') ? (
                    <span className="flex shrink-0 flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyAlert === alert.id}
                        onClick={() => void actOnAlert(alert, 'ordered')}
                      >
                        Ordered
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busyAlert === alert.id}
                        onClick={() => void actOnAlert(alert, 'acknowledge')}
                      >
                        Seen
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busyAlert === alert.id}
                        onClick={() => void actOnAlert(alert, 'resolve')}
                      >
                        Resolved
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
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

      <FormDialog
        open={receiving}
        onClose={() => setReceiving(false)}
        title="Receive goods"
        description="Creates a batch. Stock only ever moves through the ledger, never by editing a number."
        submitLabel="Receive into stock"
        message={receiveForm.message}
        width="38rem"
        disabled={!chosenItem || !receipt.locationId || !receipt.lotNumber || !receipt.quantity}
        onSubmit={receiveGoods}
      >
        <ItemChooser
          chosen={chosenItem}
          onChoose={setChosenItem}
          search={medSearch}
          onSearch={setMedSearch}
          results={medResults}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="receiveLocation"
            label="Into which store"
            required
            placeholder="Choose one"
            options={locations.map((l) => ({ value: l.id, label: `${l.name} (${humanise(l.kind)})` }))}
            value={receipt.locationId}
            error={receiveForm.errors.locationId}
            onChange={(e) => setReceipt((r) => ({ ...r, locationId: e.target.value }))}
          />
          <Field
            name="lotNumber"
            label="Lot number"
            required
            hint="From the packaging — FEFO picking and any recall key off this"
            value={receipt.lotNumber}
            error={receiveForm.errors.lotNumber}
            onChange={(e) => setReceipt((r) => ({ ...r, lotNumber: e.target.value }))}
          />
          <Field
            name="quantity"
            label={`Quantity${chosenItem ? ` (${chosenItem.base_unit})` : ''}`}
            type="number"
            step="0.001"
            required
            value={receipt.quantity}
            error={receiveForm.errors.quantity}
            onChange={(e) => setReceipt((r) => ({ ...r, quantity: e.target.value }))}
          />
          <Field
            name="unitCostCents"
            label="Unit cost"
            type="number"
            min={0}
            hint="Whole shillings, per base unit"
            value={receipt.unitCostCents}
            error={receiveForm.errors.unitCostCents}
            onChange={(e) => setReceipt((r) => ({ ...r, unitCostCents: e.target.value }))}
          />
          <Field
            name="expiresOn"
            label="Expires on"
            type="date"
            hint="Drives first-expiry-first-out picking and the expiry alerts"
            value={receipt.expiresOn}
            error={receiveForm.errors.expiresOn}
            onChange={(e) => setReceipt((r) => ({ ...r, expiresOn: e.target.value }))}
          />
        </div>
      </FormDialog>

      <FormDialog
        open={adjusting}
        onClose={() => setAdjusting(false)}
        title="Adjust stock"
        description="An adjustment is a ledger entry with a reason, not an edit — the running balance is reconstructible."
        submitLabel="Write the adjustment"
        message={adjustForm.message}
        width="38rem"
        disabled={!chosenItem || !adjustment.locationId || !adjustment.quantity || adjustment.reason.trim().length < 3}
        onSubmit={adjustStock}
      >
        <ItemChooser
          chosen={chosenItem}
          onChoose={setChosenItem}
          search={medSearch}
          onSearch={setMedSearch}
          results={medResults}
        />

        {chosenItem?.controlled_schedule ? (
          <Alert tone="serious" title={`Schedule ${chosenItem.controlled_schedule} — a second signature is required`}>
            The server refuses a controlled-substance adjustment without a witness, and records both
            names. Have the witness present before writing this.
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="adjustLocation"
            label="Which store"
            required
            placeholder="Choose one"
            options={locations.map((l) => ({ value: l.id, label: `${l.name} (${humanise(l.kind)})` }))}
            value={adjustment.locationId}
            error={adjustForm.errors.locationId}
            onChange={(e) => setAdjustment((a) => ({ ...a, locationId: e.target.value }))}
          />
          <Select
            name="movementType"
            label="What happened"
            options={[
              { value: 'wastage', label: 'Wastage — damaged or spilt' },
              { value: 'expiry', label: 'Expiry — out of date' },
              { value: 'recall', label: 'Recall — withdrawn' },
              { value: 'stock_take', label: 'Stock take — count correction' },
              { value: 'return', label: 'Return — back from a ward' },
              { value: 'adjustment', label: 'Other correction' },
            ]}
            value={adjustment.movementType}
            error={adjustForm.errors.movementType}
            onChange={(e) => setAdjustment((a) => ({ ...a, movementType: e.target.value }))}
          />
          <Field
            name="adjustQuantity"
            label={`Quantity${chosenItem ? ` (${chosenItem.base_unit})` : ''}`}
            type="number"
            step="0.001"
            required
            hint={
              ['wastage', 'expiry', 'recall'].includes(adjustment.movementType)
                ? 'Removed from stock'
                : 'Positive adds, negative removes'
            }
            value={adjustment.quantity}
            error={adjustForm.errors.quantity}
            onChange={(e) => setAdjustment((a) => ({ ...a, quantity: e.target.value }))}
          />
        </div>

        <TextArea
          name="adjustReason"
          label="Reason"
          required
          rows={2}
          hint="Written to the ledger. A stock discrepancy nobody explained is the one an auditor asks about."
          value={adjustment.reason}
          error={adjustForm.errors.reason}
          onChange={(e) => setAdjustment((a) => ({ ...a, reason: e.target.value }))}
        />
      </FormDialog>
    </>
  );
}
