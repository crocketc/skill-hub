import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REDUCED_MOTION_STORAGE_KEY,
  setUserReducedMotion,
  useSkillHubReducedMotion,
  useUserReducedMotion,
} from "./reducedMotion";
import { stubMatchMediaReducedMotion } from "./testMatchMedia";

function Probe() {
  const effective = useSkillHubReducedMotion();
  const user = useUserReducedMotion();
  return <p data-testid="probe" data-effective={effective} data-user={user}>probe</p>;
}

function effectiveState() {
  const probe = screen.getByTestId("probe");
  return {
    effective: probe.dataset.effective === "true",
    user: probe.dataset.user === "true",
  };
}

describe("SkillHub reduced motion preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem(REDUCED_MOTION_STORAGE_KEY);
    setUserReducedMotion(false);
  });

  it("defaults to motion enabled even when the operating system requests reduced motion", () => {
    stubMatchMediaReducedMotion(true);
    render(<Probe />);

    expect(effectiveState()).toEqual({ effective: false, user: false });
  });

  it("lets the SkillHub switch disable and restore motion independently of the system", () => {
    const media = stubMatchMediaReducedMotion(true);
    render(<Probe />);

    act(() => setUserReducedMotion(true));
    expect(effectiveState()).toEqual({ effective: true, user: true });

    act(() => media.setMatches(false));
    expect(effectiveState()).toEqual({ effective: true, user: true });

    act(() => setUserReducedMotion(false));
    expect(effectiveState()).toEqual({ effective: false, user: false });
  });

  it("persists the user switch through localStorage", () => {
    stubMatchMediaReducedMotion(true);
    act(() => setUserReducedMotion(true));
    expect(window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY)).toBe("true");

    act(() => setUserReducedMotion(false));
    expect(window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY)).toBeNull();
  });
});
