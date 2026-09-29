import { describe, expect, it } from "vitest";
import { BANNER, BANNER_WIDTH, COMPACT, JOLLY_ROGER, LOGO, renderBanner, renderJollyRoger } from "./banner.js";

const ANSI = /\x1b\[[0-9;]*m/;

describe("SPZ banner", () => {
  it("fits the declared width, line by line", () => {
    for (const line of BANNER.split("\n")) expect([...line].length).toBeLessThanOrEqual(BANNER_WIDTH);
    expect(LOGO.split("\n")).toHaveLength(6);
    expect(BANNER).toContain("A SPACE PIRATE ZERO JOINT");
  });

  it("is plain without color and NEON with it", () => {
    expect(renderBanner()).toBe(BANNER);
    expect(renderBanner()).not.toMatch(ANSI);
    const colored = renderBanner({ color: true });
    expect(colored).toContain("\x1b[38;5;198m"); // hot pink logo
    expect(colored).toContain("\x1b[38;5;46m"); // phosphor green tagline
    expect(colored.replace(/\x1b\[[0-9;]*m/g, "")).toBe(BANNER);
  });

  it("falls back to the one-line mark on narrow terminals", () => {
    expect(renderBanner({ columns: 60 })).toBe(COMPACT);
  });

  it("colors the Jolly Roger without changing its shape", () => {
    expect(renderJollyRoger()).toBe(JOLLY_ROGER);
    expect(renderJollyRoger({ color: true }).replace(/\x1b\[[0-9;]*m/g, "")).toBe(JOLLY_ROGER);
    expect(JOLLY_ROGER).toContain("S P Z");
  });
});
