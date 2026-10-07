'use client';

/**
 * Timezone picker.
 *
 * This replaced a free-text input, which was wrong in a way that only showed
 * up later: a timezone is not a label, it is the key by which stored instants
 * become the times printed on a clinic list. A typo did not look like a typo —
 * it saved cleanly, and then the appointment board threw a RangeError, or
 * worse, silently drifted an hour.
 *
 * Three decisions worth knowing about:
 *
 *  1. THE LIST COMES FROM THE RUNTIME, not from a hand-kept constant. ICU ships
 *     the zone database, so `Intl.supportedValuesOf` is correct on the day
 *     daylight-saving rules change in Lebanon or a new zone splits off. A
 *     hard-coded list is wrong the moment it is written; the curated fallback
 *     below exists only for runtimes without that method.
 *
 *  2. THE OPTIONS ARE BUILT AFTER MOUNT. The server and the browser can hold
 *     different ICU builds, which genuinely disagree — Node 22 lists
 *     `Asia/Calcutta` where a browser may list `Asia/Kolkata` — and offsets are
 *     computed from "now". Rendering 418 options during SSR would therefore
 *     risk a hydration mismatch on a form field. So the first render shows just
 *     the current value and the full list arrives on mount. The selected value
 *     is correct the whole time; only the choices expand.
 *
 *  3. THE CURRENT VALUE IS ALWAYS AN OPTION, even when the runtime has never
 *     heard of it. The API canonicalises through ICU and stores whichever
 *     spelling ITS build prefers, so the saved value can legitimately be
 *     absent from the browser's list. A <select> whose value matches no option
 *     renders blank — which would read as "no timezone set" and invite the user
 *     to overwrite a perfectly good one.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Enough of the world to be usable on a runtime without
 * `Intl.supportedValuesOf`, weighted to where this system is deployed.
 */
const FALLBACK_ZONES = [
  'Africa/Dar_es_Salaam', 'Africa/Nairobi', 'Africa/Kampala', 'Africa/Kigali',
  'Africa/Lagos', 'Africa/Accra', 'Africa/Cairo', 'Africa/Johannesburg',
  'Africa/Addis_Ababa', 'Africa/Lusaka', 'Africa/Harare', 'Africa/Maputo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Lisbon',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Karachi', 'Asia/Shanghai', 'Asia/Tokyo',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Australia/Sydney', 'UTC',
];

/** Region headings, in the order a <select> should present them. */
const REGION_ORDER = [
  'Africa', 'Europe', 'Asia', 'America', 'Atlantic', 'Indian',
  'Australia', 'Pacific', 'Antarctica', 'Arctic', 'Etc',
];

interface ZoneOption {
  value: string;
  label: string;
}

interface ZoneGroup {
  region: string;
  zones: ZoneOption[];
}

/** `GMT+03:00` for a zone, or null when the runtime cannot say. */
function offsetOf(timeZone: string, at: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(at);

    return parts.find((part) => part.type === 'timeZoneName')?.value ?? null;
  } catch {
    return null;
  }
}

/** `Africa/Dar_es_Salaam` -> `Dar es Salaam`; nested paths keep their middle. */
export function cityOf(zone: string): string {
  const slash = zone.indexOf('/');
  const tail = slash === -1 ? zone : zone.slice(slash + 1);
  return tail.replace(/_/g, ' ').replace(/\//g, ' / ');
}

function listZones(): string[] {
  try {
    const supported = Intl.supportedValuesOf?.('timeZone');
    if (supported && supported.length > 0) return supported;
  } catch {
    // Fall through to the curated list.
  }
  return FALLBACK_ZONES;
}

/**
 * Group the zone list by region, label each with its CURRENT offset, and make
 * sure `current` is in there somewhere.
 *
 * The offset is shown because "Africa/Juba" means nothing to most people and
 * "GMT+02:00" means something to everyone — and because it is the fastest way
 * to spot that you have picked the wrong one of two plausible names.
 */
function buildGroups(current: string, at: Date): ZoneGroup[] {
  const zones = new Set(listZones());
  if (current) zones.add(current);

  const byRegion = new Map<string, ZoneOption[]>();

  for (const zone of zones) {
    const slash = zone.indexOf('/');
    // A zone with no region prefix (`UTC`) has nowhere natural to sit.
    const region = slash === -1 ? 'Other' : zone.slice(0, slash);
    const offset = offsetOf(zone, at);

    const bucket = byRegion.get(region);
    const option = { value: zone, label: offset ? `${cityOf(zone)} · ${offset}` : cityOf(zone) };

    if (bucket) bucket.push(option);
    else byRegion.set(region, [option]);
  }

  const ordered: ZoneGroup[] = [];

  // Known regions first, in a deliberate order, then anything the runtime
  // added that this file has not heard of, then the prefix-less ones.
  const remaining = [...byRegion.keys()]
    .filter((region) => !REGION_ORDER.includes(region) && region !== 'Other')
    .sort();

  for (const region of [...REGION_ORDER, ...remaining, 'Other']) {
    const zones = byRegion.get(region);
    if (!zones) continue;
    ordered.push({
      region,
      zones: zones.sort((a, b) => a.label.localeCompare(b.label)),
    });
  }

  return ordered;
}

export function TimezoneSelect({
  name,
  label = 'Timezone',
  value,
  onChange,
  hint,
  error,
  disabled,
  required,
  /** Shown as the empty choice. Omit to make the field mandatory in practice. */
  placeholder,
}: {
  name: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
}): ReactNode {
  // See (2) above: deferred to the client so SSR and hydration cannot disagree
  // about either the zone list or the offsets in it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const groups = useMemo(() => {
    if (!mounted) {
      return value ? [{ region: 'Other', zones: [{ value, label: cityOf(value) }] }] : [];
    }
    return buildGroups(value, new Date());
  }, [mounted, value]);

  const describedBy = error ? `${name}-error` : hint ? `${name}-hint` : undefined;

  return (
    <div className="w-full">
      <label
        htmlFor={name}
        className="mb-1.5 block text-[0.8125rem] font-medium"
        style={{ color: 'var(--ink-secondary)' }}
      >
        {label}
        {required ? (
          <span className="ml-1" style={{ color: 'var(--critical-ink)' }} aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <select
        id={name}
        name={name}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className="h-9.5 w-full rounded-[var(--radius-md)] px-3 text-[0.875rem]"
        style={{
          background: 'var(--surface)',
          color: 'var(--ink)',
          border: `1px solid ${error ? 'var(--critical)' : 'var(--line-strong)'}`,
        }}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {groups.map((group) => (
          <optgroup key={group.region} label={group.region}>
            {group.zones.map((zone) => (
              <option key={zone.value} value={zone.value}>
                {zone.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {error ? (
        <p id={`${name}-error`} className="mt-1.5 text-[0.75rem]" style={{ color: 'var(--critical-ink)' }}>
          {error}
        </p>
      ) : hint ? (
        <p id={`${name}-hint`} className="mt-1.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The browser's own guess, used to pre-fill a new site's timezone. */
export function detectTimezone(): string | null {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}
