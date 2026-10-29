import {
  isJwtExpired,
  decodeJwtPayload,
  clearSessionState,
  logoutUser,
  resetLogoutState,
  getStoredSession,
  validateStoredSession,
  migrateSessionStorage,
  SessionExpiredError,
  USER_STORAGE_KEY,
  WALLET_STORAGE_KEY,
  LEGACY_STORAGE_KEYS,
} from "../session";
import * as userStore from "../../stores/useUserStore";
import * as walletStore from "../../stores/useWalletStore";

jest.mock("../../stores/useUserStore", () => ({
  useUserStore: {
    getState: jest.fn(() => ({
      clearUser: jest.fn(),
    })),
  },
}));

jest.mock("../../stores/useWalletStore", () => ({
  useWalletStore: {
    getState: jest.fn(() => ({
      disconnect: jest.fn(),
    })),
  },
}));

describe("session.ts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    jest.useRealTimers();
  });

  describe("decodeJwtPayload", () => {
    it("decodes a valid JWT payload", () => {
      const payload = { sub: "user-123", role: "borrower", exp: 1700000000 };
      const token = `header.${btoa(JSON.stringify(payload))}.signature`;

      expect(decodeJwtPayload(token)).toEqual(payload);
    });

    it("returns null for non-string or empty token", () => {
      expect(decodeJwtPayload("")).toBeNull();
      expect(decodeJwtPayload(null as unknown as string)).toBeNull();
      expect(decodeJwtPayload(undefined as unknown as string)).toBeNull();
    });

    it("returns null for token missing parts", () => {
      expect(decodeJwtPayload("single-part")).toBeNull();
    });

    it("handles URL-safe base64 with '-' and '_' and missing padding", () => {
      const payload = { sub: "user-test", note: "testing+special/characters" };
      const rawBase64 = btoa(JSON.stringify(payload))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const token = `header.${rawBase64}.sig`;

      expect(decodeJwtPayload(token)).toEqual(payload);
    });

    it("returns null for malformed base64 payload", () => {
      expect(decodeJwtPayload("header.!!!invalid-base64!!!.sig")).toBeNull();
    });

    it("returns null when decoded payload is not valid JSON", () => {
      const token = `header.${btoa("not-a-json-object")}.sig`;
      expect(decodeJwtPayload(token)).toBeNull();
    });

    it("returns null in SSR when window is undefined", () => {
      const originalWindow = global.window;
      try {
        // @ts-expect-error intentionally simulating SSR
        delete global.window;
        expect(decodeJwtPayload("header.payload.sig")).toBeNull();
      } finally {
        global.window = originalWindow;
      }
    });
  });

  describe("isJwtExpired", () => {
    it("returns true for expired token", () => {
      const exp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const payload = btoa(JSON.stringify({ exp, sub: "test" }));
      const token = `header.${payload}.signature`;

      expect(isJwtExpired(token)).toBe(true);
    });

    it("returns false for valid token", () => {
      const exp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const payload = btoa(JSON.stringify({ exp, sub: "test" }));
      const token = `header.${payload}.signature`;

      expect(isJwtExpired(token)).toBe(false);
    });

    it("returns false for token expiring in future", () => {
      const exp = Math.floor(Date.now() / 1000) + 10;
      const payload = btoa(JSON.stringify({ exp, sub: "test" }));
      const token = `header.${payload}.signature`;

      expect(isJwtExpired(token)).toBe(false);
    });

    it("returns true for token that expired 1 millisecond ago", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const payload = btoa(JSON.stringify({ exp: nowSeconds, sub: "test" }));
      const token = `header.${payload}.signature`;

      jest.useFakeTimers();
      jest.setSystemTime(nowSeconds * 1000 + 1);
      const result = isJwtExpired(token);
      jest.useRealTimers();

      expect(result).toBe(true);
    });

    it("returns false for malformed token missing payload", () => {
      const token = "header.signature";
      expect(isJwtExpired(token)).toBe(false);
    });

    it("returns false for token with invalid base64", () => {
      const token = "header.!!!invalid!!!.signature";
      expect(isJwtExpired(token)).toBe(false);
    });

    it("returns false for token with missing exp field", () => {
      const payload = btoa(JSON.stringify({ sub: "test" }));
      const token = `header.${payload}.signature`;

      expect(isJwtExpired(token)).toBe(false);
    });

    it("returns false for token with non-numeric exp field", () => {
      const payload = btoa(JSON.stringify({ exp: "not-a-number", sub: "test" }));
      const token = `header.${payload}.signature`;

      expect(isJwtExpired(token)).toBe(false);
    });

    it("handles base64url padding correctly", () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const payloadObj = { exp, sub: "test" };
      const payload = btoa(JSON.stringify(payloadObj))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      const token = `header.${payload}.signature`;

      expect(isJwtExpired(token)).toBe(false);
    });
  });

  describe("getStoredSession", () => {
    it("returns null when no session is in localStorage", () => {
      expect(getStoredSession()).toBeNull();
    });

    it("correctly extracts session from Zustand persist format", () => {
      const sessionData = {
        state: {
          user: { id: "u-1", email: "borrower@example.com", role: "borrower" },
          authToken: "mock-token",
          isAuthenticated: true,
        },
        version: 0,
      };
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(sessionData));

      const result = getStoredSession();
      expect(result).toEqual({
        user: { id: "u-1", email: "borrower@example.com", role: "borrower" },
        authToken: "mock-token",
        isAuthenticated: true,
      });
    });

    it("correctly handles flat storage object fallback", () => {
      const flatData = {
        user: { id: "u-2", email: "lender@example.com" },
        authToken: "flat-token",
        isAuthenticated: true,
      };
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(flatData));

      const result = getStoredSession();
      expect(result).toEqual({
        user: { id: "u-2", email: "lender@example.com" },
        authToken: "flat-token",
        isAuthenticated: true,
      });
    });

    it("returns null gracefully when localStorage contains malformed JSON", () => {
      localStorage.setItem(USER_STORAGE_KEY, "{broken-json-corrupted");
      expect(getStoredSession()).toBeNull();
    });

    it("returns null when stored item is a primitive value instead of object", () => {
      localStorage.setItem(USER_STORAGE_KEY, "12345");
      expect(getStoredSession()).toBeNull();

      localStorage.setItem(USER_STORAGE_KEY, '"just-a-string"');
      expect(getStoredSession()).toBeNull();
    });

    it("returns null when localStorage access throws (e.g., SecurityError in private mode)", () => {
      const getItemSpy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("The operation is insecure", "SecurityError");
      });

      expect(getStoredSession()).toBeNull();
      getItemSpy.mockRestore();
    });

    it("returns null in SSR when window is undefined", () => {
      const originalWindow = global.window;
      try {
        // @ts-expect-error simulating SSR
        delete global.window;
        expect(getStoredSession()).toBeNull();
      } finally {
        global.window = originalWindow;
      }
    });
  });

  describe("validateStoredSession", () => {
    it("returns error when session is missing", () => {
      const result = validateStoredSession();
      expect(result).toEqual({
        isValid: false,
        isExpired: false,
        isAuthorized: false,
        token: null,
        error: "Malformed or missing session",
      });
    });

    it("returns error when stored data is malformed JSON", () => {
      localStorage.setItem(USER_STORAGE_KEY, "corrupted!{json");
      const result = validateStoredSession();
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Malformed or missing session");
    });

    it("returns error when session exists but has no authToken", () => {
      localStorage.setItem(
        USER_STORAGE_KEY,
        JSON.stringify({
          state: { user: { id: "u-1" }, authToken: null, isAuthenticated: false },
        }),
      );
      const result = validateStoredSession();
      expect(result).toEqual({
        isValid: false,
        isExpired: false,
        isAuthorized: false,
        token: null,
        error: "Missing authentication token",
      });
    });

    it("detects expired session token", () => {
      const exp = Math.floor(Date.now() / 1000) - 300;
      const token = `header.${btoa(JSON.stringify({ exp, sub: "u-1" }))}.sig`;
      localStorage.setItem(
        USER_STORAGE_KEY,
        JSON.stringify({
          state: { user: { id: "u-1" }, authToken: token, isAuthenticated: true },
        }),
      );

      const result = validateStoredSession();
      expect(result).toEqual({
        isValid: false,
        isExpired: true,
        isAuthorized: false,
        token,
        error: "Session token expired",
      });
    });

    it("validates valid unexpired session without role restriction", () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = `header.${btoa(JSON.stringify({ exp, sub: "u-1" }))}.sig`;
      localStorage.setItem(
        USER_STORAGE_KEY,
        JSON.stringify({
          state: { user: { id: "u-1" }, authToken: token, isAuthenticated: true },
        }),
      );

      const result = validateStoredSession();
      expect(result).toEqual({
        isValid: true,
        isExpired: false,
        isAuthorized: true,
        token,
        error: null,
      });
    });

    it("authorizes when user has matching required role in user object", () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = `header.${btoa(JSON.stringify({ exp, sub: "u-1" }))}.sig`;
      localStorage.setItem(
        USER_STORAGE_KEY,
        JSON.stringify({
          state: {
            user: { id: "u-1", role: "admin" },
            authToken: token,
            isAuthenticated: true,
          },
        }),
      );

      const result = validateStoredSession("admin");
      expect(result.isValid).toBe(true);
      expect(result.isAuthorized).toBe(true);
      expect(result.error).toBeNull();
    });

    it("authorizes when user has matching required role from JWT claims", () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = `header.${btoa(JSON.stringify({ exp, sub: "u-1", role: "operator" }))}.sig`;
      localStorage.setItem(
        USER_STORAGE_KEY,
        JSON.stringify({
          state: {
            user: { id: "u-1" },
            authToken: token,
            isAuthenticated: true,
          },
        }),
      );

      const result = validateStoredSession("operator");
      expect(result.isValid).toBe(true);
      expect(result.isAuthorized).toBe(true);
      expect(result.error).toBeNull();
    });

    it("rejects unauthorized role mismatch while acknowledging valid token", () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = `header.${btoa(JSON.stringify({ exp, sub: "u-1", role: "borrower" }))}.sig`;
      localStorage.setItem(
        USER_STORAGE_KEY,
        JSON.stringify({
          state: {
            user: { id: "u-1", role: "borrower" },
            authToken: token,
            isAuthenticated: true,
          },
        }),
      );

      const result = validateStoredSession("admin");
      expect(result.isValid).toBe(true);
      expect(result.isExpired).toBe(false);
      expect(result.isAuthorized).toBe(false);
      expect(result.error).toContain("required role 'admin'");
    });
  });

  describe("migrateSessionStorage", () => {
    it("returns { migrated: false, recovered: false } when storage is clean", () => {
      const result = migrateSessionStorage();
      expect(result).toEqual({ migrated: false, recovered: false });
    });

    it("recovers and purges corrupted USER_STORAGE_KEY JSON", () => {
      localStorage.setItem(USER_STORAGE_KEY, "{corrupt-user-json");
      const result = migrateSessionStorage();

      expect(result.recovered).toBe(true);
      expect(localStorage.getItem(USER_STORAGE_KEY)).toBeNull();
    });

    it("recovers and purges corrupted non-object USER_STORAGE_KEY", () => {
      localStorage.setItem(USER_STORAGE_KEY, "12345");
      const result = migrateSessionStorage();

      expect(result.recovered).toBe(true);
      expect(localStorage.getItem(USER_STORAGE_KEY)).toBeNull();
    });

    it("recovers and purges corrupted WALLET_STORAGE_KEY JSON", () => {
      localStorage.setItem(WALLET_STORAGE_KEY, "{corrupt-wallet-json");
      const result = migrateSessionStorage();

      expect(result.recovered).toBe(true);
      expect(localStorage.getItem(WALLET_STORAGE_KEY)).toBeNull();
    });

    it("migrates legacy token into current Zustand structure and removes legacy key", () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const validToken = `header.${btoa(JSON.stringify({ exp, sub: "u-legacy" }))}.sig`;
      localStorage.setItem("remitlend_token", validToken);

      const result = migrateSessionStorage();
      expect(result.migrated).toBe(true);

      const currentStored = JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || "{}");
      expect(currentStored.state.authToken).toBe(validToken);
      expect(currentStored.state.isAuthenticated).toBe(true);
      expect(localStorage.getItem("remitlend_token")).toBeNull();
    });

    it("migrates legacy expired token correctly setting isAuthenticated to false", () => {
      const exp = Math.floor(Date.now() / 1000) - 1000;
      const expiredToken = `header.${btoa(JSON.stringify({ exp, sub: "u-legacy" }))}.sig`;
      localStorage.setItem("auth_token", expiredToken);

      const result = migrateSessionStorage();
      expect(result.migrated).toBe(true);

      const currentStored = JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || "{}");
      expect(currentStored.state.authToken).toBe(expiredToken);
      expect(currentStored.state.isAuthenticated).toBe(false);
      expect(localStorage.getItem("auth_token")).toBeNull();
    });

    it("cleans up legacy keys without overwriting existing USER_STORAGE_KEY", () => {
      const existingUser = {
        state: { user: { id: "current" }, authToken: "current-token", isAuthenticated: true },
        version: 0,
      };
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(existingUser));
      localStorage.setItem("remitlend_token", "old-token");

      const result = migrateSessionStorage();
      expect(result.migrated).toBe(false);
      expect(localStorage.getItem("remitlend_token")).toBeNull();

      const preserved = JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || "{}");
      expect(preserved.state.authToken).toBe("current-token");
    });

    it("returns { migrated: false, recovered: false } in SSR when window is undefined", () => {
      const originalWindow = global.window;
      try {
        // @ts-expect-error simulating SSR
        delete global.window;
        expect(migrateSessionStorage()).toEqual({ migrated: false, recovered: false });
      } finally {
        global.window = originalWindow;
      }
    });
  });

  describe("clearSessionState", () => {
    it("clears user from store", () => {
      const clearUserMock = jest.fn();
      jest.mocked(userStore.useUserStore.getState).mockReturnValue({
        clearUser: clearUserMock,
      } as unknown as ReturnType<typeof userStore.useUserStore.getState>);

      clearSessionState();

      expect(clearUserMock).toHaveBeenCalled();
    });

    it("disconnects wallet from store", () => {
      const disconnectMock = jest.fn();
      jest.mocked(walletStore.useWalletStore.getState).mockReturnValue({
        disconnect: disconnectMock,
      } as unknown as ReturnType<typeof walletStore.useWalletStore.getState>);

      clearSessionState();

      expect(disconnectMock).toHaveBeenCalled();
    });

    it("clears user and wallet storage keys along with legacy keys", () => {
      localStorage.setItem(USER_STORAGE_KEY, '{"name":"test"}');
      localStorage.setItem(WALLET_STORAGE_KEY, '{"address":"0x123"}');
      for (const legacyKey of LEGACY_STORAGE_KEYS) {
        localStorage.setItem(legacyKey, "legacy-value");
      }

      clearSessionState();

      expect(localStorage.getItem(USER_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(WALLET_STORAGE_KEY)).toBeNull();
      for (const legacyKey of LEGACY_STORAGE_KEYS) {
        expect(localStorage.getItem(legacyKey)).toBeNull();
      }
    });

    it("does not throw when localStorage access throws SecurityError (private mode)", () => {
      const removeItemSpy = jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new DOMException("Access denied", "SecurityError");
      });

      expect(() => clearSessionState()).not.toThrow();
      removeItemSpy.mockRestore();
    });

    it("does not throw in SSR when window is undefined", () => {
      const originalWindow = global.window;
      try {
        // @ts-expect-error simulating SSR
        delete global.window;
        expect(() => clearSessionState()).not.toThrow();
      } finally {
        global.window = originalWindow;
      }
    });
  });

  describe("logoutUser", () => {
    const [implSymbol] = Object.getOwnPropertySymbols(window.location);
    let originalAssign: ((url: string) => void) | undefined;
    let assignMock: jest.Mock;

    beforeEach(() => {
      resetLogoutState();
      assignMock = jest.fn();
      if (
        implSymbol &&
        (window.location as unknown as Record<symbol, { assign: (url: string) => void }>)[
          implSymbol
        ]
      ) {
        originalAssign = (
          window.location as unknown as Record<symbol, { assign: (url: string) => void }>
        )[implSymbol].assign;
        (window.location as unknown as Record<symbol, { assign: (url: string) => void }>)[
          implSymbol
        ].assign = assignMock;
      }
    });

    afterEach(() => {
      resetLogoutState();
      if (
        implSymbol &&
        originalAssign &&
        (window.location as unknown as Record<symbol, { assign: (url: string) => void }>)[
          implSymbol
        ]
      ) {
        (window.location as unknown as Record<symbol, { assign: (url: string) => void }>)[
          implSymbol
        ].assign = originalAssign;
      }
    });

    it("clears session state before logout", () => {
      const clearUserMock = jest.fn();
      const disconnectMock = jest.fn();
      jest.mocked(userStore.useUserStore.getState).mockReturnValue({
        clearUser: clearUserMock,
      } as unknown as ReturnType<typeof userStore.useUserStore.getState>);
      jest.mocked(walletStore.useWalletStore.getState).mockReturnValue({
        disconnect: disconnectMock,
      } as unknown as ReturnType<typeof walletStore.useWalletStore.getState>);

      logoutUser("manual");

      expect(clearUserMock).toHaveBeenCalled();
      expect(disconnectMock).toHaveBeenCalled();
    });

    it("redirects to home on manual logout", () => {
      logoutUser("manual");
      expect(assignMock).toHaveBeenCalledWith("/");
    });

    it("redirects to home on expired logout", () => {
      logoutUser("expired");
      expect(assignMock).toHaveBeenCalledWith("/");
    });

    it("debounces logout to prevent multiple redirects in same tick", () => {
      jest.useFakeTimers();

      logoutUser("manual");
      logoutUser("manual");

      expect(assignMock).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(0);
      jest.useRealTimers();
    });

    it("uses manual logout reason by default", () => {
      logoutUser();
      expect(assignMock).toHaveBeenCalledWith("/");
    });

    it("handles SSR without crashing when window is undefined", () => {
      const originalWindow = global.window;
      try {
        // @ts-expect-error simulating SSR
        delete global.window;
        expect(() => logoutUser("manual")).not.toThrow();
      } finally {
        global.window = originalWindow;
      }
    });
  });

  describe("SessionExpiredError", () => {
    it("is an Error instance", () => {
      const error = new SessionExpiredError();
      expect(error).toBeInstanceOf(Error);
    });

    it("has correct name", () => {
      const error = new SessionExpiredError();
      expect(error.name).toBe("SessionExpiredError");
    });

    it("has default message", () => {
      const error = new SessionExpiredError();
      expect(error.message).toBe("Session expired. Please sign in again.");
    });

    it("accepts custom message", () => {
      const error = new SessionExpiredError("Custom expired message");
      expect(error.message).toBe("Custom expired message");
    });
  });
});
