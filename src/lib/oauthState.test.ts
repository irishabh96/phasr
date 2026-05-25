import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumePendingOAuthState,
  createPendingOAuthState,
  validatePendingOAuthState,
} from "./oauthState";

describe("desktop OAuth state", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("accepts and consumes the matching pending state", () => {
    const pending = createPendingOAuthState("google");
    const result = consumePendingOAuthState(pending.state);

    expect(result.ok).toBe(true);
    expect(consumePendingOAuthState(pending.state)).toEqual({
      ok: false,
      reason: "No pending Phasr browser login.",
    });
  });

  it("can validate a matching pending state without consuming it", () => {
    const pending = createPendingOAuthState("google");
    const result = validatePendingOAuthState(pending.state);

    expect(result.ok).toBe(true);
    expect(consumePendingOAuthState(pending.state).ok).toBe(true);
  });

  it("rejects callbacks that were not started by this app", () => {
    expect(consumePendingOAuthState(null)).toEqual({
      ok: false,
      reason: "No pending Phasr browser login.",
    });
  });

  it("rejects mismatched callback state without consuming the pending login", () => {
    const pending = createPendingOAuthState("github");

    expect(consumePendingOAuthState("attacker")).toEqual({
      ok: false,
      reason: "Phasr browser login state mismatch.",
    });
    expect(consumePendingOAuthState(pending.state).ok).toBe(true);
  });

  it("rejects expired pending state", () => {
    vi.useFakeTimers();
    const pending = createPendingOAuthState("google");

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);

    expect(consumePendingOAuthState(pending.state)).toEqual({
      ok: false,
      reason: "Phasr browser login expired.",
    });
  });
});
