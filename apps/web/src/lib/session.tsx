'use client';

/**
 * Session context.
 *
 * Also the place the HIPAA automatic-logoff requirement (§164.312(a)(2)(iii))
 * is honoured on the client: the server revokes an idle session, but a screen
 * left showing a chart in an empty consulting room is the actual exposure, so
 * the UI clears itself after the same interval and warns shortly before.
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
  api,
  onSessionEnded,
  setAccessToken,
  type LoginResponse,
  type RoleKey,
  type SessionUser,
} from './api';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const IDLE_WARNING_MS = 2 * 60 * 1000;

interface SessionState {
  user: SessionUser | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  idleWarning: boolean;
  signIn: (email: string, password: string, tenantSlug?: string) => Promise<void>;
  signOut: (reason?: string) => Promise<void>;
  extendSession: () => void;
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
  hasRole: (...roles: RoleKey[]) => boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [idleWarning, setIdleWarning] = useState(false);
  const lastActivity = useRef(Date.now());

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus('anonymous');
    setIdleWarning(false);
  }, []);

  /**
   * On boot, try to exchange the httpOnly refresh cookie for an access token.
   * This is what makes a page reload keep the user signed in without ever
   * putting a long-lived credential somewhere a script could read it.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { data } = await api.post<LoginResponse>('/auth/refresh');
        if (cancelled) return;

        setAccessToken(data.accessToken);
        setUser(data.user);
        setStatus('authenticated');
      } catch {
        if (!cancelled) setStatus('anonymous');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // The client is told when the API gives up on refreshing.
  useEffect(() => onSessionEnded(clearSession), [clearSession]);

  const signOut = useCallback(
    async (_reason?: string) => {
      try {
        await api.post('/auth/logout');
      } catch {
        // Best effort: the local session is cleared either way, so a network
        // failure cannot leave a chart on screen.
      }
      clearSession();
    },
    [clearSession],
  );

  const extendSession = useCallback(() => {
    lastActivity.current = Date.now();
    setIdleWarning(false);
  }, []);

  // Idle tracking. Passive listeners so scrolling a long chart stays smooth.
  useEffect(() => {
    if (status !== 'authenticated') return;

    const markActive = () => {
      lastActivity.current = Date.now();
    };

    const events: Array<keyof WindowEventMap> = [
      'pointerdown',
      'keydown',
      'wheel',
      'touchstart',
      'focus',
    ];

    for (const event of events) {
      window.addEventListener(event, markActive, { passive: true });
    }

    const interval = window.setInterval(() => {
      const idleFor = Date.now() - lastActivity.current;

      if (idleFor >= IDLE_TIMEOUT_MS) {
        void signOut('idle');
      } else if (idleFor >= IDLE_TIMEOUT_MS - IDLE_WARNING_MS) {
        setIdleWarning(true);
      } else {
        setIdleWarning(false);
      }
    }, 15_000);

    return () => {
      for (const event of events) window.removeEventListener(event, markActive);
      window.clearInterval(interval);
    };
  }, [status, signOut]);

  const signIn = useCallback(
    async (email: string, password: string, tenantSlug?: string) => {
      try {
        const { data } = await api.post<LoginResponse>('/auth/login', {
          email,
          password,
          ...(tenantSlug ? { tenantSlug } : {}),
        });

        setAccessToken(data.accessToken);
        setUser(data.user);
        setStatus('authenticated');
        lastActivity.current = Date.now();
      } catch (error) {
        clearSession();
        throw error instanceof ApiError
          ? error
          : new ApiError(0, 'INTERNAL', 'Could not reach the server. Check your connection.');
      }
    },
    [clearSession],
  );

  const value = useMemo<SessionState>(() => {
    const permissions = new Set(user?.permissions ?? []);

    return {
      user,
      status,
      idleWarning,
      signIn,
      signOut,
      extendSession,
      can: (permission) => permissions.has(permission),
      canAny: (...list) => list.some((p) => permissions.has(p)),
      hasRole: (...roles) => roles.some((r) => user?.roles.includes(r) ?? false),
    };
  }, [user, status, idleWarning, signIn, signOut, extendSession]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside a <SessionProvider>');
  }
  return context;
}

/**
 * Permission-gated rendering.
 *
 * A convenience, never a control: hiding a button is a UI courtesy, and the
 * API enforces the same permission server-side on every call.
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: string | string[];
  children: ReactNode;
  fallback?: ReactNode;
}): ReactNode {
  const { canAny } = useSession();
  const permissions = Array.isArray(permission) ? permission : [permission];
  return canAny(...permissions) ? children : fallback;
}
