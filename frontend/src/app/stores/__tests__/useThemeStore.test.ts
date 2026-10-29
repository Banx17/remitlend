import {
  useThemeStore,
  selectTheme,
  selectThemeHydrated,
  resetThemeListenerState,
} from "../useThemeStore";
import {
  THEME_STORAGE_KEY,
  getStoredTheme,
  getSystemTheme,
  resolveInitialTheme,
  applyTheme,
  type Theme,
} from "../../lib/theme";

describe("useThemeStore & theme helpers", () => {
  let mediaQueryListeners: Array<(e: MediaQueryListEvent) => void> = [];
  let isSystemDark = false;

  const createMockMediaQuery = () => {
    return {
      get matches() {
        return isSystemDark;
      },
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: jest.fn((event: string, listener: (e: MediaQueryListEvent) => void) => {
        if (event === "change") {
          mediaQueryListeners.push(listener);
        }
      }),
      removeEventListener: jest.fn((event: string, listener: (e: MediaQueryListEvent) => void) => {
        if (event === "change") {
          mediaQueryListeners = mediaQueryListeners.filter((l) => l !== listener);
        }
      }),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    };
  };

  const triggerSystemThemeChange = (matches: boolean) => {
    isSystemDark = matches;
    const event = { matches, media: "(prefers-color-scheme: dark)" } as MediaQueryListEvent;
    mediaQueryListeners.forEach((listener) => listener(event));
  };

  beforeEach(() => {
    mediaQueryListeners = [];
    isSystemDark = false;
    resetThemeListenerState();

    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.theme;

    useThemeStore.setState({
      theme: "light",
      hydrated: false,
    });

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: jest.fn().mockImplementation(() => {
        return createMockMediaQuery();
      }),
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.theme;
    resetThemeListenerState();
  });

  describe("SSR & Pre-rendered Dataset Hydration", () => {
    it("starts with initial unhydrated state", () => {
      const state = useThemeStore.getState();
      expect(selectTheme(state)).toBe("light");
      expect(selectThemeHydrated(state)).toBe(false);
    });

    it("hydrates from pre-rendered SSR document dataset 'dark'", () => {
      document.documentElement.dataset.theme = "dark";

      useThemeStore.getState().initializeTheme();

      const state = useThemeStore.getState();
      expect(state.theme).toBe("dark");
      expect(state.hydrated).toBe(true);
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(document.documentElement.dataset.theme).toBe("dark");
    });

    it("hydrates from pre-rendered SSR document dataset 'light'", () => {
      document.documentElement.dataset.theme = "light";
      document.documentElement.classList.add("dark");

      useThemeStore.getState().initializeTheme();

      const state = useThemeStore.getState();
      expect(state.theme).toBe("light");
      expect(state.hydrated).toBe(true);
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(document.documentElement.dataset.theme).toBe("light");
    });

    it("hydrates from pre-rendered SSR document dataset 'system' resolving to dark", () => {
      isSystemDark = true;
      document.documentElement.dataset.theme = "system";

      useThemeStore.getState().initializeTheme();

      const state = useThemeStore.getState();
      expect(state.theme).toBe("system");
      expect(state.hydrated).toBe(true);
      expect(document.documentElement.dataset.theme).toBe("system");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("hydrates from pre-rendered SSR document dataset 'system' resolving to light", () => {
      isSystemDark = false;
      document.documentElement.dataset.theme = "system";

      useThemeStore.getState().initializeTheme();

      const state = useThemeStore.getState();
      expect(state.theme).toBe("system");
      expect(state.hydrated).toBe(true);
      expect(document.documentElement.dataset.theme).toBe("system");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("falls back to stored theme when SSR dataset theme is invalid", () => {
      document.documentElement.dataset.theme = "invalid-custom-theme";
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

      useThemeStore.getState().initializeTheme();

      const state = useThemeStore.getState();
      expect(state.theme).toBe("dark");
      expect(state.hydrated).toBe(true);
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("repeated initializeTheme calls are idempotent and maintain hydration", () => {
      isSystemDark = true;
      useThemeStore.getState().initializeTheme();
      expect(useThemeStore.getState().hydrated).toBe(true);

      useThemeStore.getState().initializeTheme();
      expect(useThemeStore.getState().hydrated).toBe(true);
      expect(useThemeStore.getState().theme).toBe("dark");
    });

    it("handles SSR environment gracefully when window or document is undefined", () => {
      const originalWindow = global.window;
      try {
        // @ts-expect-error simulating SSR
        delete global.window;
        expect(getSystemTheme()).toBe("light");
        expect(getStoredTheme()).toBeNull();
      } finally {
        global.window = originalWindow;
      }
    });
  });

  describe("Invalid Persisted Themes & Storage Fault Tolerance", () => {
    it.each(["neon", "dim", "auto", "high-contrast", "null", "undefined", "123", "", "{}"])(
      "rejects invalid persisted theme string '%s' and returns null",
      (invalidTheme) => {
        window.localStorage.setItem(THEME_STORAGE_KEY, invalidTheme);
        expect(getStoredTheme()).toBeNull();
      },
    );

    it("falls back to system preference when persisted theme in localStorage is invalid", () => {
      isSystemDark = true;
      window.localStorage.setItem(THEME_STORAGE_KEY, "corrupted-theme-value");

      useThemeStore.getState().initializeTheme();

      const state = useThemeStore.getState();
      expect(state.theme).toBe("dark");
      expect(state.hydrated).toBe(true);
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("handles localStorage.getItem throwing SecurityError without crashing", () => {
      const getItemSpy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("Access is denied", "SecurityError");
      });

      expect(getStoredTheme()).toBeNull();
      expect(() => resolveInitialTheme()).not.toThrow();

      getItemSpy.mockRestore();
    });

    it("handles localStorage.setItem throwing QuotaExceededError without crashing setTheme", () => {
      const setItemSpy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });

      expect(() => useThemeStore.getState().setTheme("dark")).not.toThrow();

      const state = useThemeStore.getState();
      expect(state.theme).toBe("dark");
      expect(state.hydrated).toBe(true);
      expect(document.documentElement.classList.contains("dark")).toBe(true);

      setItemSpy.mockRestore();
    });

    it("safely falls back to light when setTheme receives an invalid theme value", () => {
      // @ts-expect-error intentionally testing invalid runtime theme argument
      useThemeStore.getState().setTheme("invalid-theme");

      const state = useThemeStore.getState();
      expect(state.theme).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    });
  });

  describe("System Preference Changes (matchMedia events)", () => {
    it("updates document when theme is 'system' and preference changes to dark", () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "system");
      isSystemDark = false;

      useThemeStore.getState().initializeTheme();
      expect(document.documentElement.classList.contains("dark")).toBe(false);

      triggerSystemThemeChange(true);

      const state = useThemeStore.getState();
      expect(state.theme).toBe("system");
      expect(document.documentElement.dataset.theme).toBe("system");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("updates document when theme is 'system' and preference changes to light", () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "system");
      isSystemDark = true;

      useThemeStore.getState().initializeTheme();
      expect(document.documentElement.classList.contains("dark")).toBe(true);

      triggerSystemThemeChange(false);

      const state = useThemeStore.getState();
      expect(state.theme).toBe("system");
      expect(document.documentElement.dataset.theme).toBe("system");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("dynamically updates theme when no preference is stored (first visit)", () => {
      isSystemDark = false;
      useThemeStore.getState().initializeTheme();
      expect(useThemeStore.getState().theme).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);

      triggerSystemThemeChange(true);

      expect(useThemeStore.getState().theme).toBe("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);

      triggerSystemThemeChange(false);

      expect(useThemeStore.getState().theme).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("does not override explicit user choice 'dark' when system changes to light", () => {
      useThemeStore.getState().setTheme("dark");
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

      useThemeStore.getState().initializeTheme();
      triggerSystemThemeChange(false);

      expect(useThemeStore.getState().theme).toBe("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("does not override explicit user choice 'light' when system changes to dark", () => {
      useThemeStore.getState().setTheme("light");
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

      useThemeStore.getState().initializeTheme();
      triggerSystemThemeChange(true);

      expect(useThemeStore.getState().theme).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("attaches system theme listener only once across multiple initializeTheme calls", () => {
      useThemeStore.getState().initializeTheme();
      useThemeStore.getState().initializeTheme();
      useThemeStore.getState().initializeTheme();

      expect(mediaQueryListeners).toHaveLength(1);
    });
  });

  describe("Theme Toggling & Transitions", () => {
    it("cycles correctly: light -> dark -> system -> light", () => {
      useThemeStore.setState({ theme: "light", hydrated: true });
      expect(useThemeStore.getState().theme).toBe("light");

      useThemeStore.getState().toggleTheme();
      expect(useThemeStore.getState().theme).toBe("dark");
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);

      useThemeStore.getState().toggleTheme();
      expect(useThemeStore.getState().theme).toBe("system");
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");

      useThemeStore.getState().toggleTheme();
      expect(useThemeStore.getState().theme).toBe("light");
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it.each<[Theme, boolean]>([
      ["dark", true],
      ["light", false],
    ])("setTheme('%s') updates DOM and persists to localStorage", (theme, shouldHaveDarkClass) => {
      useThemeStore.getState().setTheme(theme);

      const state = useThemeStore.getState();
      expect(state.theme).toBe(theme);
      expect(state.hydrated).toBe(true);
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(theme);
      expect(document.documentElement.classList.contains("dark")).toBe(shouldHaveDarkClass);
      expect(document.documentElement.dataset.theme).toBe(theme);
    });

    it("applyTheme handles 'system' with dark system preference", () => {
      isSystemDark = true;
      applyTheme("system");

      expect(document.documentElement.dataset.theme).toBe("system");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("applyTheme handles 'system' with light system preference", () => {
      isSystemDark = false;
      applyTheme("system");

      expect(document.documentElement.dataset.theme).toBe("system");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("applyTheme handles SSR without document gracefully", () => {
      const originalDocument = global.document;
      try {
        // @ts-expect-error simulating SSR
        delete global.document;
        expect(() => applyTheme("dark")).not.toThrow();
      } finally {
        global.document = originalDocument;
      }
    });
  });
});
