/**
 * hooks/useLoanStream.test.tsx
 *
 * Regression coverage for #2119: loan event streams previously had no tests
 * for reconnects, duplicate events, or cleanup when the route changes.
 *
 * These tests drive the real `useSSE` transport with a controllable fetch
 * response so reconnect/backoff behaviour is exercised end-to-end rather
 * than asserted against a mocked hook.
 */

import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TextEncoder } from "node:util";
import { useLoanStream } from "./useLoanStream";
import { queryKeys } from "./useApi";
import { useUserStore } from "../stores/useUserStore";

(globalThis as Record<string, unknown>).TextEncoder = TextEncoder;

const BORROWER = "GBORROWER1234567890";
const STREAM_URL = `http://localhost:3001/api/events/stream?borrower=${encodeURIComponent(BORROWER)}`;

interface SseConnection {
  response: {
    ok: boolean;
    status: number;
    statusText: string;
    body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } };
  };
  /** The AbortSignal the hook passed to fetch for this connection. */
  signal: AbortSignal | undefined;
  /** Queue a `data:` frame for the hook to decode. */
  push: (payload: unknown) => void;
  /** Queue a raw frame, used to exercise malformed server output. */
  pushRaw: (frame: string) => void;
  /** Close the stream cleanly (reader.read() resolves with done: true). */
  close: () => void;
}

/**
 * A single fake SSE connection. Reads block until an event is pushed or the
 * stream closes/aborts, which mirrors a real long-lived stream and lets the
 * tests control exact framing order.
 */
function createConnection(signal: AbortSignal | undefined): SseConnection {
  const encoder = new TextEncoder();
  const queue: Uint8Array[] = [];
  let pending: ((result: { done: boolean; value?: Uint8Array }) => void) | null = null;
  let closed = false;

  const flush = () => {
    if (!pending) return;
    if (queue.length > 0) {
      const resolve = pending;
      pending = null;
      resolve({ done: false, value: queue.shift() as Uint8Array });
    } else if (closed) {
      const resolve = pending;
      pending = null;
      resolve({ done: true, value: undefined });
    }
  };

  signal?.addEventListener("abort", () => {
    closed = true;
    flush();
  });

  const reader = {
    read: () => {
      if (queue.length > 0) {
        return Promise.resolve({ done: false, value: queue.shift() as Uint8Array });
      }
      if (closed) {
        return Promise.resolve({ done: true, value: undefined });
      }
      return new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
        pending = resolve;
        flush();
      });
    },
  };

  return {
    response: {
      ok: true,
      status: 200,
      statusText: "OK",
      body: { getReader: () => reader },
    },
    signal,
    push: (payload: unknown) => {
      queue.push(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      flush();
    },
    pushRaw: (frame: string) => {
      queue.push(encoder.encode(`${frame}\n\n`));
      flush();
    },
    close: () => {
      closed = true;
      flush();
    },
  };
}

function createSseServer() {
  const connections: SseConnection[] = [];
  const fetchMock = jest.fn((_url: string, init?: RequestInit) => {
    const connection = createConnection(init?.signal ?? undefined);
    connections.push(connection);
    return Promise.resolve(connection.response);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, connections };
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** Number of cache entries the hook invalidated for a given query key. */
function invalidated(queryClient: QueryClient, queryKey: readonly unknown[]) {
  const invalidate = queryClient.invalidateQueries as jest.Mock;
  const calls = invalidate.mock.calls as Array<[{ queryKey?: readonly unknown[] }]>;
  return calls.filter(([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(queryKey))
    .length;
}

function allInvalidations(queryClient: QueryClient) {
  return (queryClient.invalidateQueries as jest.Mock).mock.calls.length;
}

async function flush() {
  await act(async () => {});
}

describe("useLoanStream", () => {
  let queryClient: QueryClient;
  let invalidateSpy: jest.SpyInstance;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    useUserStore.setState({
      user: {
        id: "u1",
        email: "u1@example.com",
        walletAddress: BORROWER,
        kycVerified: true,
      },
      authToken: "test-token",
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    invalidateSpy = jest.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("subscribes to the borrower-scoped stream with the auth token", async () => {
    const { fetchMock } = createSseServer();

    const { result } = renderHook(() => useLoanStream("1"), {
      wrapper: createWrapper(queryClient),
    });

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(STREAM_URL);
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(result.current).toBe("connected");
  });

  it("does not open a stream when no loan id is selected", async () => {
    const { fetchMock } = createSseServer();

    const { result } = renderHook(() => useLoanStream(undefined), {
      wrapper: createWrapper(queryClient),
    });

    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBe("disconnected");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does not open a stream when the wallet is not connected (authorization)", async () => {
    useUserStore.setState({ user: null, authToken: null, isAuthenticated: false });
    const { fetchMock } = createSseServer();

    const { result } = renderHook(() => useLoanStream("1"), {
      wrapper: createWrapper(queryClient),
    });

    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBe("disconnected");
  });

  it("invalidates the loan detail, amortization and borrower lists on a matching event", async () => {
    const { connections } = createSseServer();

    renderHook(() => useLoanStream("1"), { wrapper: createWrapper(queryClient) });
    await flush();

    await act(async () => {
      connections[0].push({ eventType: "LoanRepaid", loanId: 1 });
    });

    expect(invalidated(queryClient, queryKeys.loans.detail("1"))).toBe(1);
    expect(invalidated(queryClient, [...queryKeys.loans.detail("1"), "amortization"])).toBe(1);
    expect(invalidated(queryClient, queryKeys.borrowerLoans.byAddress(BORROWER))).toBe(1);
    expect(invalidated(queryClient, queryKeys.loans.borrowerPagePrefix(BORROWER))).toBe(1);
    expect(allInvalidations(queryClient)).toBe(4);
  });

  it("ignores unrelated events, other loans and the init frame", async () => {
    const { connections } = createSseServer();

    renderHook(() => useLoanStream("1"), { wrapper: createWrapper(queryClient) });
    await flush();

    await act(async () => {
      connections[0].push({ type: "init", loanId: 1 });
      connections[0].push({ eventType: "LoanApproved", loanId: 1 });
      connections[0].push({ eventType: "LoanRepaid", loanId: 2 });
      connections[0].push({ eventType: "LoanRepaid" });
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("ignores malformed frames without tearing down the stream", async () => {
    const { connections } = createSseServer();
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useLoanStream("1"), { wrapper: createWrapper(queryClient) });
    await flush();

    // A malformed frame is decoded by the hook but rejected by JSON.parse.
    await act(async () => {
      connections[0].push({ eventType: "LoanRepaid", loanId: 1 });
      connections[0].pushRaw("data: {not-json");
    });

    // The malformed frame is dropped; the valid one still refreshed the loan.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(allInvalidations(queryClient)).toBe(4);

    await act(async () => {
      // Clear the 500ms debounce window left by the valid frame above.
      jest.advanceTimersByTime(500);
      connections[0].push({ eventType: "LoanLiquidated", loanId: 1 });
    });
    expect(allInvalidations(queryClient)).toBe(8);
  });

  it("coalesces duplicate events inside the 500ms debounce window", async () => {
    const { connections } = createSseServer();

    renderHook(() => useLoanStream("1"), { wrapper: createWrapper(queryClient) });
    await flush();

    await act(async () => {
      connections[0].push({ eventType: "LoanRepaid", loanId: 1 });
      connections[0].push({ eventType: "LoanRepaid", loanId: 1 });
    });
    expect(allInvalidations(queryClient)).toBe(4);

    // 499ms later the duplicate is still suppressed.
    await act(async () => {
      jest.advanceTimersByTime(499);
      connections[0].push({ eventType: "LoanRepaid", loanId: 1 });
    });
    expect(allInvalidations(queryClient)).toBe(4);

    // Exactly 500ms after the last refresh the next event is accepted again.
    await act(async () => {
      jest.advanceTimersByTime(1);
      connections[0].push({ eventType: "LateFeeCharged", loanId: 1 });
    });
    expect(allInvalidations(queryClient)).toBe(8);
  });

  it("reconnects after the stream closes and keeps applying events", async () => {
    const { fetchMock, connections } = createSseServer();

    renderHook(() => useLoanStream("1"), { wrapper: createWrapper(queryClient) });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      connections[0].push({ eventType: "LoanRepaid", loanId: 1 });
    });
    expect(allInvalidations(queryClient)).toBe(4);

    // The server ends the stream cleanly (idle timeout, deploy, LB cutoff).
    await act(async () => {
      connections[0].close();
      await jest.advanceTimersByTimeAsync(1_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(connections[1].signal).not.toBe(connections[0].signal);

    // The reconnected stream is still wired to the query cache.
    await act(async () => {
      connections[1].push({ eventType: "LoanRepaid", loanId: 1 });
    });
    expect(allInvalidations(queryClient)).toBe(8);
  });

  it("falls back to polling after repeated connection failures", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useLoanStream("1"), {
      wrapper: createWrapper(queryClient),
    });

    // Initial attempt + 1s + 2s backoff = 3 failed attempts, then polling.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_100);
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toBe("polling");
    // Polling refreshes immediately on entry so the UI recovers without input.
    expect(allInvalidations(queryClient)).toBe(4);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(allInvalidations(queryClient)).toBe(8);
  });

  it("aborts the active connection and stops refreshing after unmount", async () => {
    const { fetchMock, connections } = createSseServer();

    const hook = renderHook(() => useLoanStream("1"), {
      wrapper: createWrapper(queryClient),
    });
    await flush();
    expect(connections[0].signal?.aborted).toBe(false);

    hook.unmount();

    expect(connections[0].signal?.aborted).toBe(true);

    // Late frames from the old stream and any pending reconnect timer must be
    // inert after the route that owned the hook is gone.
    await act(async () => {
      connections[0].push({ eventType: "LoanRepaid", loanId: 1 });
      await jest.advanceTimersByTimeAsync(10_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("re-subscribes and filters by the new loan after a route change", async () => {
    const { fetchMock, connections } = createSseServer();

    const hook: RenderHookResult<ReturnType<typeof useLoanStream>, { loanId: string }> = renderHook(
      ({ loanId }: { loanId: string }) => useLoanStream(loanId),
      { initialProps: { loanId: "1" }, wrapper: createWrapper(queryClient) },
    );
    await flush();

    hook.rerender({ loanId: "2" });
    await flush();

    // The borrower-scoped URL did not change, so the existing stream is kept.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      connections[0].push({ eventType: "LoanRepaid", loanId: 1 });
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    await act(async () => {
      connections[0].push({ eventType: "LoanRepaid", loanId: 2 });
    });
    expect(invalidated(queryClient, queryKeys.loans.detail("2"))).toBe(1);
    expect(invalidated(queryClient, queryKeys.loans.detail("1"))).toBe(0);
  });

  it("closes the old borrower stream when the connected wallet changes", async () => {
    const { fetchMock, connections } = createSseServer();
    const nextBorrower = "GNEXTBORROWER9876543210";

    renderHook(() => useLoanStream("1"), { wrapper: createWrapper(queryClient) });
    await flush();

    await act(async () => {
      useUserStore.setState({
        user: {
          id: "u1",
          email: "u1@example.com",
          walletAddress: nextBorrower,
          kycVerified: true,
        },
      });
    });
    await flush();

    expect(connections[0].signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `http://localhost:3001/api/events/stream?borrower=${encodeURIComponent(nextBorrower)}`,
    );
  });
});
