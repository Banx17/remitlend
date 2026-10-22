"use client";

import { useEffect } from "react";
import { useLogout } from "../../hooks/useLogout";
import { useUserStore } from "../../stores/useUserStore";

/**
 * SessionExpiryHandler
 *
 * Mounts once at app root level. Listens for the `auth:session-expired`
 * custom DOM event dispatched by `apiFetch` on HTTP 401 responses and
 * triggers a full logout with an explanatory redirect query parameter so
 * the landing page can show a "Your session expired" notice.
 *
 * Place this inside the providers wrapper so it has access to
 * the router and query client contexts.
 */
export function SessionExpiryHandler() {
  const { logout } = useLogout();

  useEffect(() => {
    const handler = () => {
      // Several in-flight requests can each 401 before the first redirect
      // commits, and another tab can expire at the same time. Only the first
      // event belongs to a live session; navigating again would bounce the
      // user between routes instead of showing the expiry notice once.
      const { authToken, isAuthenticated } = useUserStore.getState();
      if (!authToken && !isAuthenticated) return;

      logout({ sessionExpired: true });
    };

    window.addEventListener("auth:session-expired", handler);
    return () => {
      window.removeEventListener("auth:session-expired", handler);
    };
  }, [logout]);

  return null;
}
