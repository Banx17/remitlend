/**
 * components/ui/TransactionStatusTracker.test.tsx
 *
 * Covers the rendered contract for each transaction state: which controls
 * appear, the progress value for in-flight states, and the explorer link.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionStatusTracker, type TransactionStatusState } from "./TransactionStatusTracker";

const baseProps = { title: "Repay loan", message: "Working on it" };

describe("TransactionStatusTracker", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<TransactionStatusTracker state="idle" {...baseProps} />);

    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["signing", 25],
    ["submitting", 55],
    ["polling", 85],
  ] as [TransactionStatusState, number][])(
    "shows an in-flight progress bar at %s (%i%%)",
    (state, progress) => {
      const { container } = render(<TransactionStatusTracker state={state} {...baseProps} />);

      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(container.querySelector(".bg-blue-600")).toHaveStyle({ width: `${progress}%` });
    },
  );

  it("offers Cancel only while a transaction is in flight", () => {
    const onCancel = jest.fn();
    render(<TransactionStatusTracker state="submitting" {...baseProps} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers Retry with a custom label after an error", () => {
    const onRetry = jest.fn();
    render(
      <TransactionStatusTracker
        state="error"
        {...baseProps}
        message="Signature rejected"
        retryLabel="Try again"
        onRetry={onRetry}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Signature rejected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers Retry after a cancellation", () => {
    render(<TransactionStatusTracker state="cancelled" {...baseProps} onRetry={jest.fn()} />);

    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("hides Retry when no onRetry handler is supplied", () => {
    render(<TransactionStatusTracker state="error" {...baseProps} />);

    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows neither control on success and no progress bar", () => {
    const { container } = render(
      <TransactionStatusTracker
        state="success"
        {...baseProps}
        onCancel={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-blue-600")).not.toBeInTheDocument();
  });

  it("disables the visible controls when disabled is set", () => {
    render(
      <TransactionStatusTracker state="polling" {...baseProps} disabled onCancel={jest.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("links to the explorer only when a transaction hash is provided", () => {
    const { rerender } = render(
      <TransactionStatusTracker state="success" {...baseProps} txHash="abc123" />,
    );

    expect(screen.getByRole("link", { name: "View on-chain transaction" })).toHaveAttribute(
      "href",
      "https://stellar.expert/explorer/testnet/tx/abc123",
    );

    rerender(<TransactionStatusTracker state="success" {...baseProps} txHash={null} />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
