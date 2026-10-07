'use client';

/**
 * Console session.
 *
 * Deliberately not reusing `useSession`: that one is a hospital's session,
 * and conflating them would mean a single `status === 'authenticated'` could
 * be satisfied by either credential. The two realms do not share a provider
 * any more than they share a token.
 *
 * The idle timeout is SHORTER than the clinical one. A clinician's screen
 * locking mid-note is a real cost on a ward, which is why that side allows
 * fifteen minutes; an operator's console can reach every hospital in the
 * deployment, so the same trade does not apply.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  onPlatformSessionEnded,
  platformApi,
  setPlatformToken,
  type Operator,
} from './platform-api';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

interface PlatformSessionState {
  operator: Operator | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Used by the invite flow, which signs in as a side effect of setting a password. */
  adopt: (accessToken: string, operator: Operator) => void;
}

const PlatformSessionContext = createContext<PlatformSessionState | null>(null);

export function PlatformSessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [status, setStatus] = useState<PlatformSessionState['status']>('loading');
  const lastActivity = useRef(Date.now());

  const clear = useCallback(() => {
    setPlatformToken(null);
    setOperator(null);
    setStatus('anonymous');
  }, []);

  // Exchange the httpOnly refresh cookie on boot, so a reload keeps the
  // operator signed in without a long-lived credential living anywhere a
  // script could read it.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const ok = await platformApi.refresh();
      if (cancelled) return;

      if (!ok) {
        setStatus('anonymous');
        return;
      }

      try {
        const { data } = await platformApi.get<Operator>('/me');
        if (cancelled) return;
        setOperator(data);
        setStatus('authenticated');
      } catch {
        if (!cancelled) setStatus('anonymous');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => onPlatformSessionEnded(clear), [clear]);

  // Idle logoff.
  useEffect(() => {
    if (status !== 'authenticated') return;

    const bump = () => {
      lastActivity.current = Date.now();
    };
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'] as const;
    for (const event of events) window.addEventListener(event, bump, { passive: true });

    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current >= IDLE_TIMEOUT_MS) clear();
    }, 15_000);

    return () => {
      for (const event of events) window.removeEventListener(event, bump);
      window.clearInterval(timer);
    };
  }, [status, clear]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data } = await platformApi.post<{ accessToken: string; operator: Omit<Operator, 'sessionId'> }>(
      '/auth/login',
      { email, password },
    );

    setPlatformToken(data.accessToken);
    const me = await platformApi.get<Operator>('/me');
    setOperator(me.data);
    setStatus('authenticated');
  }, []);

  const adopt = useCallback((accessToken: string, next: Operator) => {
    setPlatformToken(accessToken);
    setOperator(next);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await platformApi.post('/auth/logout');
    } catch (error) {
      // An already-dead session is still a successful sign-out from here.
      if (!(error instanceof ApiError)) throw error;
    } finally {
      clear();
    }
  }, [clear]);

  const value = useMemo<PlatformSessionState>(
    () => ({ operator, status, signIn, signOut, adopt }),
    [operator, status, signIn, signOut, adopt],
  );

  return (
    <PlatformSessionContext.Provider value={value}>{children}</PlatformSessionContext.Provider>
  );
}

export function usePlatformSession(): PlatformSessionState {
  const context = useContext(PlatformSessionContext);
  if (!context) {
    throw new Error('usePlatformSession must be used inside a <PlatformSessionProvider>');
  }
  return context;
}
