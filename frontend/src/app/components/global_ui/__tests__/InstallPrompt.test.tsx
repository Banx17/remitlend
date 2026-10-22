import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallPrompt, DISMISSED_STORAGE_KEY } from "../InstallPrompt";

interface MockBeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  outcome: "accepted" | "dismissed";
}

function createInstallEvent(outcome: "accepted" | "dismissed"): MockBeforeInstallPromptEvent {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as MockBeforeInstallPromptEvent;
  event.prompt = vi.fn(() => Promise.resolve());
  event.userChoice = Promise.resolve({ outcome });
  event.outcome = outcome;
  return event;
}

function dispatchBeforeInstallPrompt(outcome: "accepted" | "dismissed") {
  const event = createInstallEvent(outcome);
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe("InstallPrompt", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders nothing when the browser does not support install prompts", () => {
    const { container } = render(<InstallPrompt />);

    expect(container).toBeEmpty();
    expect(screen.queryByText(/Install RemitLend for offline access/i)).not.toBeInTheDocument();
  });

  it("shows the prompt when the browser fires beforeinstallprompt", () => {
    render(<InstallPrompt />);

    dispatchBeforeInstallPrompt("accepted");

    expect(
      screen.getByText(/Install RemitLend for offline access/i)
    ).toBeInTheDocument();
    expect(screen.getByButtonName(/^install$/i)).toBeInTheDocument();
  });

  it("prevents the default browser behavior for the install event", () => {
    render(<InstallPrompt />);

    const event = dispatchBeforeInstallPrompt("accepted");

    expect(event.defaultPrevented).toBe(true);
  });

  it("calls prompt and removes the prompt when the user accepts", async () => {
    render(<InstallPrompt />);

    const event = dispatchBeforeInstallPrompt("accepted");

    await act(async () => {
      screen.getByButtonName(/^install$/i).click();
    });

    expect(event.prompt).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        screen.queryByText(/Install RemitLend for offline access/i)
      ).not.toBeInTheDocument()
    );
  });

  it("keeps the prompt visible when the user dismisses the native install dialog", async () => {
    render(<InstallPrompt />);

    const event = dispatchBeforeInstallPrompt("dismissed");

    await act(async () => {
      screen.getByButtonName(/^install$/i).click();
    });

    expect(event.prompt).toHaveBeenCalledOnce();
    expect(
      screen.getByText(/Install RemitLend for offline access/i)
    ).toBeInTheDocument();
  });

  it("hides the prompt when the user clicks the dismiss button", () => {
    render(<InstallPrompt />);

    dispatchBeforeInstallPrompt("accepted");

    act(() => {
      screen.getByButtonName(/dismiss install prompt/i).click();
    });

    expect(
      screen.queryByText(/Install RemitLend for offline access/i)
    ).not.toBeInTheDocument();
  });

  it("persists the dismissal to localStorage", () => {
    render(<InstallPrompt />);

    dispatchBeforeInstallPrompt("accepted");

    act(() => {
      screen.getByButtonName(/dismiss install prompt/i).click();
    });

    expect(window.localStorage.getItem(DISMISSED_STORAGE_KEY)).toBe("true");
  });

  it("stays hidden on mount when a dismissal was previously persisted", () => {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, "true");

    render(<InstallPrompt />);

    dispatchBeforeInstallPrompt("accepted");

    expect(
      screen.queryByText(/Install RemitLend for offline access/i)
    ).not.toBeInTheDocument();
  });

  it("removes the beforeinstallprompt listener on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<InstallPrompt />);

    unmount();

    expect(removeSpy).toHaveBeenCalledWith(
      "beforeinstallprompt",
      expect.anything
    );
  });
});
