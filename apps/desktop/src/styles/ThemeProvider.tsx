import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import {
  type AppearancePreference,
  resolveTheme,
  type ThemeName,
  themeNames,
} from "./theme";

export const THEME_STORAGE_KEY = "skillhub.appearance";
const systemDarkQuery = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  appearance: AppearancePreference;
  resolvedTheme: ThemeName;
  setAppearance: (appearance: AppearancePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isAppearancePreference(value: string): value is AppearancePreference {
  return (
    value === "system" ||
    value === "light" ||
    value === "dark" ||
    themeNames.includes(value as ThemeName)
  );
}

function readStoredAppearance(): AppearancePreference {
  if (typeof window === "undefined") {
    return "system";
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored && isAppearancePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(systemDarkQuery).matches
  );
}

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [appearance, setAppearance] =
    useState<AppearancePreference>(readStoredAppearance);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const resolvedTheme = resolveTheme(appearance, prefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return undefined;
    }

    const media = window.matchMedia(systemDarkQuery);
    const update = () => setPrefersDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, appearance);
    } catch {
      // Storage may be disabled; the in-memory selection still applies.
    }
  }, [appearance, resolvedTheme]);

  const value = useMemo(
    () => ({ appearance, resolvedTheme, setAppearance }),
    [appearance, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
