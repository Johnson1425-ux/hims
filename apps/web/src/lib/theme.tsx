'use client';

/**
 * Theme toggle.
 *
 * Dark mode is not cosmetic in a hospital: night staff on a ward with the
 * lights down should not be flashbanged by a white chart, and a bright screen
 * in a sleeping patient's room is a genuine complaint. The viewer's explicit
 * choice wins over the OS setting, and persists per device.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeState {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);
const STORAGE_KEY = 'hims.theme';

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [theme, setThemeState] = useState<Theme>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    let stored: Theme = 'system';

    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      if (value === 'light' || value === 'dark' || value === 'system') stored = value;
    } catch {
      // Private browsing or blocked storage: fall back to the OS preference.
    }

    setThemeState(stored);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      const next = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      setResolved(next);

      // The attribute is what the CSS token scopes key off.
      if (theme === 'system') {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', theme);
      }
    };

    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisting is acceptable; the session still honours the choice.
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside a <ThemeProvider>');
  return context;
}
