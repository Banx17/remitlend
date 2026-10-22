/**
 * hooks/useApi.retryCancellation.test.tsx
 *
 * Covers retry and cancellation behavior of the API hooks:
 * - useCreditScore's SSE stream reconnects with exponential backoff, and
 *   stops reconnecting once the component unmounts.
 * - useCreditScore's query gives up after its configured retries.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCreditScore } from "./useApi";
import { useUserStore, type User } from "../stores/useUserStore";

// A non-JWT token: apiFetch treats it as unexpired, so requests go through.
const TOKEN = "test-token";
const WALLET = "GBORROWER123";
const USER_ID = "42";

const isStreamUrl = (url: unknown) => String(url).includes("/api/events/stream");
const isScoreUrl = (url: unknown) => String(url).includes(`/score/${USER_ID}`);

function createWrapper(queryRetry: number | false) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: queryRetry, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const scoreResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ score: 700 }),
});

describe("useCreditScore SSE reconnection", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  const streamCalls = () => fetchMock.mock.calls.filter(([url]) => isStreamUrl(url)).length;
  const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

  beforeEach(() => {
    jest.useFakeTimers();
    useUserStore.setState({
      user: { walletAddress: WALLET } as unknown as User,
      authToken: TOKEN,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("reconnects with exponential backoff after each failed attempt", async () => {
    let attempts = 0;
    fetchMock = jest.fn((url: unknown) => {
      if (isScoreUrl(url)) return Promise.resolve(scoreResponse());
      attempts += 1;
      // Fail twice, then keep the stream open.
      return attempts <= 2 ? Promise.reject(new TypeError("network down")) : new Promise(() => {});
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    renderHook(() => useCreditScore(USER_ID), { wrapper: createWrapper(false) });
    await advance(0);
    expect(streamCalls()).toBe(1);

    // First retry waits 1s.
    await advance(999);
    expect(streamCalls()).toBe(1);
    await advance(1);
    expect(streamCalls()).toBe(2);

    // Second retry waits 2s.
    await advance(1_999);
    expect(streamCalls()).toBe(2);
    await advance(1);
    expect(streamCalls()).toBe(3);
  });

  it("cancels a pending reconnect when the component unmounts", async () => {
    fetchMock = jest.fn((url: unknown) =>
      isScoreUrl(url)
        ? Promise.resolve(scoreResponse())
        : Promise.reject(new TypeError("network down")),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { unmount } = renderHook(() => useCreditScore(USER_ID), {
      wrapper: createWrapper(false),
    });
    await advance(0);
    expect(streamCalls()).toBe(1);

    unmount();
    await advance(60_000);

    expect(streamCalls()).toBe(1);
  });

  it("aborts the in-flight stream on unmount without scheduling a retry", async () => {
    let streamSignal: AbortSignal | undefined;
    fetchMock = jest.fn((url: unknown, init?: RequestInit) => {
      if (isScoreUrl(url)) return Promise.resolve(scoreResponse());
      streamSignal = init?.signal ?? undefined;
      return new Promise((_, reject) => {
        streamSignal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { unmount } = renderHook(() => useCreditScore(USER_ID), {
      wrapper: createWrapper(false),
    });
    await advance(0);
    expect(streamSignal?.aborted).toBe(false);

    unmount();
    await advance(60_000);

    expect(streamSignal?.aborted).toBe(true);
    expect(streamCalls()).toBe(1);
  });
});

describe("useCreditScore query retry exhaustion", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    useUserStore.setState({
      user: { walletAddress: WALLET } as unknown as User,
      authToken: TOKEN,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("stops after the configured retries and surfaces the last error", async () => {
    const fetchMock = jest.fn((url: unknown) =>
      isScoreUrl(url)
        ? Promise.resolve({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            json: async () => ({ message: "score unavailable" }),
          })
        : new Promise(() => {}),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useCreditScore(USER_ID), {
      wrapper: createWrapper(2),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const scoreCalls = fetchMock.mock.calls.filter(([url]) => isScoreUrl(url)).length;
    // One initial attempt plus two retries.
    expect(scoreCalls).toBe(3);
    expect(result.current.error?.message).toBe("score unavailable");
  });
});
