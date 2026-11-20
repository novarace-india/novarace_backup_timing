/**
 * RACE RESULT numeric codes.
 * Verified against the SampleSESFiles event files and cross-checked with
 * the RR knowledge base worked examples (see docs/rr14-reference.md §3).
 * Entries marked "inferred" are not documented by RR — treat as best effort.
 */

/** RR stores times and distances as fixed-point ×10000 in the .ses database. */
export const RR_FIXED = 10000;

export const TYPE_OF_SPORT: Record<number, { label: string; isStart?: boolean; isPreStart?: boolean }> = {
  255: { label: "Start (last read)", isStart: true },
  254: { label: "Pre-start / check-in", isPreStart: true },
  253: { label: "Start (first read)", isStart: true },
  250: { label: "Transition" },
  100: { label: "Running" },
  11: { label: "Cycling" },
  10: { label: "Other / activity" },
  4: { label: "Swimming" },
};

export function sportLabel(code: number): string {
  return TYPE_OF_SPORT[code]?.label ?? `Sport ${code}`;
}

/** Split TimeMode — how the min/max validity window is expressed. */
export const TIME_MODE: Record<number, { label: string; unit: "sec" | "speed" | "pace" }> = {
  0: { label: "Race time from T0", unit: "sec" },
  [-1]: { label: "Time of day", unit: "sec" },
  [-2]: { label: "Time from previous split", unit: "sec" },
  [-3]: { label: "Pace min/km", unit: "pace" },
  [-4]: { label: "Pace min/mile (inferred)", unit: "pace" },
  [-5]: { label: "Pace min/100m", unit: "pace" },
  [-6]: { label: "Speed km/h", unit: "speed" },
  [-7]: { label: "Speed mph (inferred)", unit: "speed" },
  [-8]: { label: "Speed m/s (inferred)", unit: "speed" },
};

export function timeModeLabel(code: number): string {
  if (code > 0) return `Time from split #${code} (inferred)`;
  return TIME_MODE[code]?.label ?? `Mode ${code}`;
}

export const SPLIT_TYPE: Record<number, "split" | "internal" | "leg"> = {
  0: "split",
  2: "internal",
  9: "leg",
};

export const STATUS: Record<number, string> = {
  0: "Regular",
  1: "Out of competition",
  2: "DSQ",
  3: "DNF",
  4: "DNS",
  5: "No show",
};

export const ADDITIONAL_FIELD_TYPE: Record<number, string> = {
  0: "Text",
  1: "Drop-down",
  2: "Check box",
  3: "Number (integer)",
  4: "Number (decimal)",
};

/** Output list Order.Grouping (inferred from KB wording + genuine exports). */
export const GROUPING_CODE = { none: 0, header: 1, filter: 2, filterIgnore: 3 } as const;

export const ALIGN_CODE = { left: 1, right: 2, center: 3 } as const;
