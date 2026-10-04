'use client';

/**
 * The hospital's own record: facilities, departments, currency, locale.
 *
 * Fetched once for the whole signed-in session rather than per screen, because
 * four of the screens need the facility and department lists to render a
 * filter, and none of them should each pay for that.
 *
 * It also decides how money is written. The tenant row carries `currency` and
 * `locale`, and a multi-tenant system cannot have one right answer baked into
 * the bundle — a hospital in Dar es Salaam bills TSh and one in Nairobi KSh,
 * from the same deployment.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, type TenantProfile } from './api';
import { setMoneyFormat } from './format';
import { useSession } from './session';

interface TenantState {
  tenant: TenantProfile | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  reload: () => void;
}

const TenantContext = createContext<TenantState | null>(null);

export function TenantProvider({ children }: { children: ReactNode }): ReactNode {
  const { status: sessionStatus } = useSession();
  const [tenant, setTenant] = useState<TenantProfile | null>(null);
  const [status, setStatus] = useState<TenantState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;

    const controller = new AbortController();

    void (async () => {
      try {
        const { data } = await api.get<TenantProfile>('/tenant', undefined, controller.signal);
        setTenant(data);
        setStatus('ready');
        setError(null);

        // Applied before the first amount renders, so nothing is briefly shown
        // in the wrong currency and then corrected.
        setMoneyFormat({ currency: data.currency, locale: data.locale });
      } catch (caught) {
        if (controller.signal.aborted) return;
        setStatus('error');
        setError(caught instanceof ApiError ? caught.message : 'Could not load hospital settings.');
      }
    })();

    return () => controller.abort();
  }, [sessionStatus, reloadToken]);

  const value = useMemo<TenantState>(
    () => ({ tenant, status, error, reload }),
    [tenant, status, error, reload],
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantState {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenant must be used inside a <TenantProvider>');
  }
  return context;
}
