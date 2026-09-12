import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REDUCED_MOTION_STORAGE_KEY,
  setUserReducedMotion,
  usePrefersReducedMotion,
  useSystemPrefersReducedMotion,
  useUserReducedMotion,
} from "./reducedMotion";
import { stubMatchMediaReducedMotion } from "./testMatchMedia";

function Probe() {
  const effective = usePrefersReducedMotion();
  const system = useSystemPrefersReducedMotion();
  const user = useUserReducedMotion();
  return (
    <p data-testid="probe" data-effective={effective} data-system={system} data-user={user}>
      probe
    </p>
  );
}

function effectiveState() {
  const probe = screen.getByTestId("probe");
  return {
    effective: probe.dataset.effective === "true",
    system: probe.dataset.system === "true",
    user: probe.dataset.user === "true",
  };
}

describe("reduced motion preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem(REDUCED_MOTION_STORAGE_KEY);
    setUserReducedMotion(false);
  });

  it("defaults to no user override and follows the system query only", () => {
    stubMatchMediaReducedMotion(false);
    render(<Probe />);

    expect(effectiveState()).toEqual({ effective: false, system: false, user: false });
  });

  it("treats an enabled system preference as reduced motion", () => {
    stubMatchMediaReducedMotion(true);
    render(<Probe />);

    expect(effectiveState()).toEqual({ effective: true, system: true, user: false });
  });

  it("lets the user switch force reduced motion while the system allows motion", () => {
    stubMatchMediaReducedMotion(false);
    render(<Probe />);

    act(() => {
      setUserReducedMotion(true);
    });
    expect(effectiveState()).toEqual({ effective: true, system: false, user: true });

    act(() => {
      setUserReducedMotion(false);
    });
    expect(effectiveState()).toEqual({ effective: false, system: false, user: false });
  });

  it("keeps reduced motion when both the system preference and the user switch are on", () => {
    stubMatchMediaReducedMotion(true);
    render(<Probe />);

    act(() => {
      setUserReducedMotion(true);
    });
    expect(effectiveState()).toEqual({ effective: true, system: true, user: true });
  });

  it("persists the user switch through localStorage while it is on", () => {
    stubMatchMediaReducedMotion(false);
    act(() => {
      setUserReducedMotion(true);
    });
    expect(window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY)).toBe("true");

    act(() => {
      setUserReducedMotion(false);
    });
    expect(window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY)).toBeNull();
  });

  it("reacts to a system preference change while mounted", () => {
    const media = stubMatchMediaReducedMotion(false);
    render(<Probe />);

    act(() => {
      media.setMatches(true);
    });
    expect(effectiveState().effective).toBe(true);

    act(() => {
      media.setMatches(false);
    });
    expect(effectiveState().effective).toBe(false);
  });
});
