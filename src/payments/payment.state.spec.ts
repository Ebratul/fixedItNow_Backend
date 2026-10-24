import { describe, expect, it } from "vitest";
import type { PaymentStatus, RefundStatus } from "../generated/prisma/client.js";
import { assertPaymentTransition, assertRefundTransition, canTransitionPayment, canTransitionRefund, InvalidPaymentTransitionError } from "./payment.state.js";

const ALL: PaymentStatus[] = ["PENDING", "INITIATED", "PROCESSING", "SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED", "REQUIRES_REVIEW", "PARTIALLY_REFUNDED", "REFUNDED"];

describe("payment state machine", () => {
  it("allows the documented happy path", () => {
    for (const [a, b] of [["PENDING", "INITIATED"], ["INITIATED", "PROCESSING"], ["PROCESSING", "SUCCEEDED"], ["SUCCEEDED", "PARTIALLY_REFUNDED"], ["PARTIALLY_REFUNDED", "REFUNDED"], ["SUCCEEDED", "REFUNDED"]] as const) {
      expect(canTransitionPayment(a, b), `${a}->${b}`).toBe(true);
    }
  });

  it("only ever reaches SUCCEEDED from a state where the customer could still have paid", () => {
    const into = ALL.filter((from) => canTransitionPayment(from, "SUCCEEDED"));
    expect(into.sort()).toEqual(["CANCELLED", "EXPIRED", "FAILED", "INITIATED", "PROCESSING"]);
    expect(canTransitionPayment("PENDING", "SUCCEEDED")).toBe(false); // never reached the provider
    expect(canTransitionPayment("REQUIRES_REVIEW", "SUCCEEDED")).toBe(false);
  });

  it("never downgrades a settled payment", () => {
    for (const settled of ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const) {
      for (const bad of ["PENDING", "INITIATED", "PROCESSING", "FAILED", "CANCELLED", "EXPIRED", "REQUIRES_REVIEW"] as const) {
        expect(canTransitionPayment(settled, bad), `${settled}->${bad}`).toBe(false);
      }
    }
    expect(ALL.some((to) => canTransitionPayment("REFUNDED", to))).toBe(false);
  });

  it("reaches the refund states only from verified-money states", () => {
    for (const from of ALL) {
      const ok = canTransitionPayment(from, "REFUNDED") || canTransitionPayment(from, "PARTIALLY_REFUNDED");
      expect(ok, from).toBe(["SUCCEEDED", "PARTIALLY_REFUNDED", "REQUIRES_REVIEW"].includes(from));
    }
  });

  it("throws a typed error for an invalid move", () => {
    expect(() => assertPaymentTransition("SUCCEEDED", "FAILED")).toThrow(InvalidPaymentTransitionError);
    expect(() => assertPaymentTransition("INITIATED", "SUCCEEDED")).not.toThrow();
  });
});

describe("refund state machine", () => {
  const R: RefundStatus[] = ["REQUESTED", "APPROVED", "PROCESSING", "SUCCEEDED", "FAILED", "REJECTED"];
  it("approval does not skip to success; only PROCESSING can succeed or fail", () => {
    expect(canTransitionRefund("REQUESTED", "SUCCEEDED")).toBe(false);
    expect(canTransitionRefund("APPROVED", "SUCCEEDED")).toBe(false);
    expect(canTransitionRefund("PROCESSING", "SUCCEEDED")).toBe(true);
    expect(canTransitionRefund("PROCESSING", "FAILED")).toBe(true);
    expect(R.filter((from) => canTransitionRefund(from, "SUCCEEDED"))).toEqual(["PROCESSING"]);
  });
  it("terminal refunds do not move", () => {
    for (const end of ["SUCCEEDED", "FAILED", "REJECTED"] as const) expect(R.some((to) => canTransitionRefund(end, to))).toBe(false);
    expect(() => assertRefundTransition("REJECTED", "APPROVED")).toThrow();
  });
});
