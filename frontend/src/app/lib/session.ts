"use client";

import { useUserStore } from "../stores/useUserStore";
import { useWalletStore } from "../stores/useWalletStore";

export const USER_STORAGE_KEY = "remitlend-user";
export const WALLET_STORAGE_KEY = "remitlend-wallet";
export const LEGACY_STORAGE_KEYS = [
  "auth_token",
  "remitlend_token",
  "remitlend_user",
  "remitlend_session",
] as const;

let logoutTriggered = false;

export class SessionExpiredError extends Error {
  constructor(message = "Session expired. Please sign in again.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  const payload = parts[1];
  if (!payload || typeof window === "undefined") {
    return null;
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(window.atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export function isJwtExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;

  return typeof exp === "number" && exp * 1000 <= Date.now();
}

export interface StoredSessionPayload {
  user: Record<string, unknown> | null;
  authToken: string | null;
  isAuthenticated: boolean;
}

export const getStoredSession = (): StoredSessionPayload | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    // Zustand persist shape: { state: { user, authToken, isAuthenticated }, version: number }
    if ("state" in parsed && typeof parsed.state === "object" && parsed.state !== null) {
      const state = parsed.state as Record<string, unknown>;
      return {
        user: (state.user as Record<string, unknown>) ?? null,
        authToken: typeof state.authToken === "string" ? state.authToken : null,
        isAuthenticated: Boolean(state.isAuthenticated),
      };
    }

    // Flat object fallback
    return {
      user: (parsed.user as Record<string, unknown>) ?? null,
      authToken: typeof parsed.authToken === "string" ? parsed.authToken : null,
      isAuthenticated: Boolean(parsed.isAuthenticated || parsed.user || parsed.authToken),
    };
  } catch {
    // Malformed storage JSON or storage access restriction
    return null;
  }
};

export interface SessionValidationResult {
  isValid: boolean;
  isExpired: boolean;
  isAuthorized: boolean;
  token: string | null;
  error: string | null;
}

export const validateStoredSession = (requiredRole?: string): SessionValidationResult => {
  const session = getStoredSession();

  if (!session) {
    return {
      isValid: false,
      isExpired: false,
      isAuthorized: false,
      token: null,
      error: "Malformed or missing session",
    };
  }

  const token = session.authToken;
  if (!token) {
    return {
      isValid: false,
      isExpired: false,
      isAuthorized: false,
      token: null,
      error: "Missing authentication token",
    };
  }

  if (isJwtExpired(token)) {
    return {
      isValid: false,
      isExpired: true,
      isAuthorized: false,
      token,
      error: "Session token expired",
    };
  }

  if (requiredRole) {
    const payload = decodeJwtPayload(token);
    const userRole =
      (typeof session.user?.role === "string" ? session.user.role : null) ??
      (typeof payload?.role === "string" ? payload.role : null);

    if (userRole !== requiredRole) {
      return {
        isValid: true,
        isExpired: false,
        isAuthorized: false,
        token,
        error: `Unauthorized: required role '${requiredRole}' but found '${userRole ?? "none"}'`,
      };
    }
  }

  return {
    isValid: true,
    isExpired: false,
    isAuthorized: true,
    token,
    error: null,
  };
};

export interface SessionMigrationResult {
  migrated: boolean;
  recovered: boolean;
}

export const migrateSessionStorage = (): SessionMigrationResult => {
  if (typeof window === "undefined") {
    return { migrated: false, recovered: false };
  }

  let recovered = false;
  let migrated = false;

  // 1. Check for corrupted/malformed storage under USER_STORAGE_KEY
  try {
    const rawUser = window.localStorage.getItem(USER_STORAGE_KEY);
    if (rawUser !== null) {
      try {
        const parsed = JSON.parse(rawUser);
        if (typeof parsed !== "object" || parsed === null) {
          window.localStorage.removeItem(USER_STORAGE_KEY);
          recovered = true;
        }
      } catch {
        // Corrupted JSON: purge it to recover store hydration
        window.localStorage.removeItem(USER_STORAGE_KEY);
        recovered = true;
      }
    }
  } catch {
    // Storage access error
  }

  // 2. Check for corrupted/malformed storage under WALLET_STORAGE_KEY
  try {
    const rawWallet = window.localStorage.getItem(WALLET_STORAGE_KEY);
    if (rawWallet !== null) {
      try {
        const parsedWallet = JSON.parse(rawWallet);
        if (typeof parsedWallet !== "object" || parsedWallet === null) {
          window.localStorage.removeItem(WALLET_STORAGE_KEY);
          recovered = true;
        }
      } catch {
        window.localStorage.removeItem(WALLET_STORAGE_KEY);
        recovered = true;
      }
    }
  } catch {
    // Storage access error
  }

  // 3. Migrate legacy storage keys if current USER_STORAGE_KEY is not set
  try {
    const currentSession = window.localStorage.getItem(USER_STORAGE_KEY);
    for (const legacyKey of LEGACY_STORAGE_KEYS) {
      const legacyVal = window.localStorage.getItem(legacyKey);
      if (legacyVal) {
        if (!currentSession) {
          // If legacy token found, migrate to Zustand persist structure
          const migratedState = {
            state: {
              user: null,
              authToken: legacyVal,
              isAuthenticated: !isJwtExpired(legacyVal),
            },
            version: 0,
          };
          window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(migratedState));
          migrated = true;
        }
        // Purge legacy key after migrating
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Storage error
  }

  return { migrated, recovered };
};

export function clearSessionState() {
  useUserStore.getState().clearUser();
  useWalletStore.getState().disconnect();

  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(USER_STORAGE_KEY);
      window.localStorage.removeItem(WALLET_STORAGE_KEY);
      for (const legacyKey of LEGACY_STORAGE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    } catch {
      // Ignore storage errors (e.g., SecurityError in private browsing)
    }
  }
}

export const resetLogoutState = () => {
  logoutTriggered = false;
};

export function logoutUser(reason: "manual" | "expired" = "manual") {
  clearSessionState();

  if (typeof window === "undefined" || logoutTriggered) {
    return;
  }

  logoutTriggered = true;
  const destination = reason === "expired" ? "/" : "/";
  window.setTimeout(() => {
    logoutTriggered = false;
  }, 0);
  window.location.assign(destination);
}
