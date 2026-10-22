/**
 * components/transaction/CollateralActionModal.test.tsx
 *
 * Covers confirmation for collateral actions: cancellation, failed signatures,
 * and balance checks that must follow the latest wallet balance.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CollateralActionModal from "./CollateralActionModal";

const baseProps = {
  open: true,
  title: "Deposit collateral",
  onClose: jest.fn(),
  onSubmit: jest.fn(),
};

function typeAmount(value: string) {
  fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value } });
}

const confirmButton = () => screen.getByRole("button", { name: /confirm|processing/i });

describe("CollateralActionModal", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<CollateralActionModal {...baseProps} open={false} />);

    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["", "empty"],
    ["0", "zero"],
    ["-5", "negative"],
  ])("keeps Confirm disabled for an invalid amount (%s, %s)", (value) => {
    render(<CollateralActionModal {...baseProps} />);

    typeAmount(value);

    expect(confirmButton()).toBeDisabled();
  });

  it("submits the entered amount and clears the input on success", async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<CollateralActionModal {...baseProps} onSubmit={onSubmit} />);

    typeAmount("12.5");
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("12.5"));
    await waitFor(() => expect(screen.getByPlaceholderText("0.00")).toHaveValue(null));
    expect(screen.queryByText(/declined|failed/i)).not.toBeInTheDocument();
  });

  it("shows the error and keeps the amount when the signature is rejected", async () => {
    const onSubmit = jest.fn().mockRejectedValue(new Error("User declined signature"));
    render(<CollateralActionModal {...baseProps} onSubmit={onSubmit} />);

    typeAmount("10");
    fireEvent.click(confirmButton());

    expect(await screen.findByText("User declined signature")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("0.00")).toHaveValue(10);
    expect(confirmButton()).toBeEnabled();
  });

  it("falls back to a generic message when the rejection is not an Error", async () => {
    const onSubmit = jest.fn().mockRejectedValue("nope");
    render(<CollateralActionModal {...baseProps} onSubmit={onSubmit} />);

    typeAmount("10");
    fireEvent.click(confirmButton());

    expect(await screen.findByText("Transaction failed")).toBeInTheDocument();
  });

  it("blocks a second submit and disables Cancel while the first is in flight", async () => {
    let finishSubmit!: () => void;
    const onSubmit = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSubmit = resolve;
        }),
    );
    const onClose = jest.fn();
    render(<CollateralActionModal {...baseProps} onSubmit={onSubmit} onClose={onClose} />);

    typeAmount("10");
    fireEvent.click(confirmButton());

    expect(await screen.findByRole("button", { name: "Processing..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByPlaceholderText("0.00")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Processing..." }));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    finishSubmit();
    await waitFor(() => expect(confirmButton()).toBeDisabled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when the user cancels", () => {
    const onClose = jest.fn();
    render(<CollateralActionModal {...baseProps} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(baseProps.onSubmit).not.toHaveBeenCalled();
  });

  it("blocks an amount that exceeds the current balance", () => {
    render(<CollateralActionModal {...baseProps} balance={100} />);

    typeAmount("150");

    expect(screen.getByText("Amount exceeds wallet balance")).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  it("re-validates against a balance that drops after the amount was entered", () => {
    const { rerender } = render(<CollateralActionModal {...baseProps} balance={100} />);

    typeAmount("80");
    expect(confirmButton()).toBeEnabled();

    // Stale balance refreshed from the chain: the amount no longer fits.
    rerender(<CollateralActionModal {...baseProps} balance={50} />);

    expect(screen.getByText("Amount exceeds wallet balance")).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  it("disables Confirm while the parent reports loading", () => {
    render(<CollateralActionModal {...baseProps} loading />);

    typeAmount("5");

    expect(confirmButton()).toBeDisabled();
  });
});
