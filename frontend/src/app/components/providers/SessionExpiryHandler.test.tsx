/**
 * components/providers/SessionExpiryHandler.test.tsx
 *
 * Regression coverage for #2125: session expiry previously had no tests for
 * concurrent 401s (multiple in-flight requests / another tab), redirect loops,
 * or cleanup when the handler unmounts.
 *
 * These tests exercise the real `useLogout` flow so the documented contract is
 * asserted end-to-end: clear the session stores, purge the query cache, and
 * replace the route with the `reason=session_expired` notice flag.
 */

const mockRouter = {
  replace: jest.fn(),
  push: jest.fn(),
};

jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionExpiryHandler } from "./SessionExpiryHandler";
import { useUserStore } from "../../stores/useUserStore";
import { useWalletStore } from "../../stores/useWalletStore";
import { useGamificationStore } from "../../stores/useGamificationStore";

const WALLET_ADDRESS = "GBORROWER1234567890";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function setActiveSession() {
  useUserStore.setState({
    user: {
      id: "u1",
      email: "u1@example.com",
      walletAddress: WALLET_ADDRESS,
      kycVerified: true,
    },
    authToken: "test-token",
    isAuthenticated: true,
    isLoading: false,
    error: null,
  });
  useWalletStore.getState().setConnected(WALLET_ADDRESS, {
    chainId: 1,
    name: "Stellar",
    isSupported: true,
  });
  useGamificationStore.getState().addXP(50, "session test");
}

function dispatchSessionExpired() {
  act(() => {
    window.dispatchEvent(new CustomEvent("auth:session-expired"));
  });
}

describe("SessionExpiryHandler", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    setActiveSession();
    queryClient.setQueryData(["loans", "1"], { id: "1", principal: 500 });
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("clears the session and redirects with the expiry notice on a 401 event", () => {
    render(<SessionExpiryHandler />, { wrapper: createWrapper(queryClient) });

    dispatchSessionExpired();

    // Session stores are fully reset so no stale credentials survive.
    expect(useUserStore.getState().authToken).toBeNull();
    expect(useUserStore.getState().user).toBeNull();
    expect(useUserStore.getState().isAuthenticated).toBe(false);

    expect(useWalletStore.getState().status).toBe("disconnected");
    expect(useWalletStore.getState().address).toBeNull();
    expect(useGamificationStore.getState().xp).toBe(0);

    // Cached server data must not leak into the next session.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);

    // Redirect uses `replace` so the expired route cannot be reached with the
    // back button, and carries the flag the landing page renders.
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/?reason=session_expired");
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("ignores unrelated auth events", () => {
    render(<SessionExpiryHandler />, { wrapper: createWrapper(queryClient) });

    act(() => {
      window.dispatchEvent(new CustomEvent("auth:token-refreshed"));
      window.dispatchEvent(new Event("storage"));
    });

    expect(useUserStore.getState().authToken).toBe("test-token");
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
  });

  it("treats concurrent 401s as a single logout and redirect", () => {
    render(<SessionExpiryHandler />, { wrapper: createWrapper(queryClient) });

    // Several requests can 401 before the first redirect commits, and another
    // tab can expire at the same moment. Only the first event may navigate.
    dispatchSessionExpired();
    dispatchSessionExpired();
    dispatchSessionExpired();

    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/?reason=session_expired");
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("does not redirect when there is no live session (redirect-loop guard)", () => {
    useUserStore.setState({
      user: null,
      authToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });

    render(<SessionExpiryHandler />, { wrapper: createWrapper(queryClient) });

    dispatchSessionExpired();

    // An unauthenticated 401 cannot expire anything; redirecting would bounce
    // the user between the landing page and a protected route indefinitely.
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
  });

  it("stops listening after unmount", () => {
    const { unmount } = render(<SessionExpiryHandler />, {
      wrapper: createWrapper(queryClient),
    });

    unmount();
    dispatchSessionExpired();

    expect(useUserStore.getState().authToken).toBe("test-token");
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
  });
});
