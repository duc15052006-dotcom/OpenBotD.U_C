import { describe, expect, test } from "bun:test";
import {
  OwnerPaymentApprovalConflictError,
  OwnerPaymentApprovalForbiddenError,
  OwnerPaymentApprovalNotRequiredError,
  requireOwnerApprovalTarget,
  type OwnerApprovalTarget,
} from "../src/economy/approval-store";

const target: OwnerApprovalTarget = {
  intentId: "intent-1",
  agentId: "agent-a",
  policyVersion: 7,
  decision: "OWNER_CONFIRMATION",
  ownerUserId: "owner-a",
};

describe("Agent Economy Owner approval store policy", () => {
  test("binds approval authority to the Agent owner", () => {
    expect(requireOwnerApprovalTarget(target, "owner-a")).toEqual(target);
    expect(() => requireOwnerApprovalTarget(target, "other-user")).toThrow(
      OwnerPaymentApprovalForbiddenError,
    );
  });

  test("checks ownership before revealing whether confirmation was required", () => {
    expect(() =>
      requireOwnerApprovalTarget(
        { ...target, decision: "ALLOW" },
        "other-user",
      ),
    ).toThrow(OwnerPaymentApprovalForbiddenError);
    expect(() =>
      requireOwnerApprovalTarget(
        { ...target, decision: "DENY" },
        "other-user",
      ),
    ).toThrow(OwnerPaymentApprovalForbiddenError);
  });

  test("refuses approval when the immutable intent did not require confirmation", () => {
    expect(() =>
      requireOwnerApprovalTarget({ ...target, decision: "ALLOW" }, "owner-a"),
    ).toThrow(OwnerPaymentApprovalNotRequiredError);

    expect(() =>
      requireOwnerApprovalTarget({ ...target, decision: "DENY" }, "owner-a"),
    ).toThrow(OwnerPaymentApprovalNotRequiredError);
  });

  test("fails closed when an Agent has no human Owner", () => {
    expect(() =>
      requireOwnerApprovalTarget({ ...target, ownerUserId: null }, "owner-a"),
    ).toThrow(OwnerPaymentApprovalForbiddenError);
  });

  test("refuses an invalid historical policy binding", () => {
    expect(() =>
      requireOwnerApprovalTarget({ ...target, policyVersion: 0 }, "owner-a"),
    ).toThrow(OwnerPaymentApprovalConflictError);
  });
});
