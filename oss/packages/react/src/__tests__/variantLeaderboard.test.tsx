import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { CollectorApi, VariantLeaderboardRow } from "../../api";
import {
  VariantLeaderboardView,
  formatDwell,
  formatRate,
} from "../catalog/views/VariantLeaderboard";

afterEach(cleanup);

const rows = (over?: Partial<VariantLeaderboardRow>): VariantLeaderboardRow[] => [
  {
    variant: "red",
    views: 6,
    sessions: 4,
    conversions: 0,
    avgDwellMs: 2000,
    conversionRate: 0,
    ...over,
  },
  { variant: "blue", views: 3, sessions: 3, conversions: 0, avgDwellMs: 0, conversionRate: 0 },
  {
    variant: "add_to_cart",
    views: 2,
    sessions: 2,
    conversions: 0,
    avgDwellMs: 0,
    conversionRate: 0,
  },
];

describe("formatDwell", () => {
  it("shows an em dash when there is no later boundary", () => {
    expect(formatDwell(0)).toBe("—");
    expect(formatDwell(-5)).toBe("—");
  });
  it("scales the unit with the magnitude", () => {
    expect(formatDwell(450)).toBe("450 ms");
    expect(formatDwell(2500)).toBe("2.5 s");
    expect(formatDwell(42000)).toBe("42 s");
    expect(formatDwell(90000)).toBe("1.5 min");
  });
});

describe("formatRate", () => {
  it("is an em dash until a success event is chosen", () => {
    expect(formatRate(0.5, false)).toBe("—");
  });
  it("renders a percentage once a success event is chosen", () => {
    expect(formatRate(0, true)).toBe("0%");
    expect(formatRate(0.75, true)).toBe("75%");
    expect(formatRate(0.032, true)).toBe("3.2%");
  });
});

describe("VariantLeaderboardView (#150)", () => {
  it("shows an empty state when there are no variants", () => {
    render(<VariantLeaderboardView initialRows={[]} api={{} as CollectorApi} params={{}} />);
    expect(screen.getByText(/No configurator variants/i)).toBeTruthy();
  });

  it("ranks variants and hides conversion until a success event is picked", () => {
    render(<VariantLeaderboardView initialRows={rows()} api={{} as CollectorApi} params={{}} />);
    // Ranked list carries the variant names (also appear as picker options).
    expect(screen.getAllByText("red").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("blue").length).toBeGreaterThanOrEqual(1);
    // Conversion column is "—" for every row before a success event is chosen.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("re-fetches with the chosen success event and shows conversion rates", async () => {
    const variantLeaderboard = vi.fn().mockResolvedValue([
      {
        variant: "red",
        views: 6,
        sessions: 4,
        conversions: 3,
        avgDwellMs: 2000,
        conversionRate: 0.75,
      },
      { variant: "blue", views: 3, sessions: 3, conversions: 0, avgDwellMs: 0, conversionRate: 0 },
    ]);
    const api = { variantLeaderboard } as unknown as CollectorApi;
    render(<VariantLeaderboardView initialRows={rows()} api={api} params={{ scene: "shop" }} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "add_to_cart" } });

    await waitFor(() => expect(variantLeaderboard).toHaveBeenCalledTimes(1));
    expect(variantLeaderboard).toHaveBeenCalledWith(
      { conversion: { type: "custom", name: "add_to_cart" } },
      { scene: "shop" },
    );
    await waitFor(() => expect(screen.getByText("75%")).toBeTruthy());
  });
});
