import { describe, expect, it } from "vitest";
import { compass, compassDeg, readingAt, weatherReadingSchema, weatherSettingsSchema, windText, type Observation } from "../src";

const obs = (at: string, o: Partial<Observation>): Observation => ({ at, tempC: null, windKmh: null, windDeg: null, gustKmh: null, precipLastHourMm: null, ...o });

describe("weather", () => {
  it("compass points both ways", () => {
    expect(compass(0)).toBe("N");
    expect(compass(200)).toBe("SSW");
    expect(compass(349)).toBe("N");
    expect(compass(null)).toBeNull();
    expect(compassDeg("SW")).toBe(225);
  });

  it("the reading nearest the time, with the day's rain, in mph, °F and inches", () => {
    const list = [
      obs("2026-05-01T12:53:00Z", { tempC: 20, windKmh: 16.09, windDeg: 180, precipLastHourMm: 2.54 }),
      obs("2026-05-01T13:53:00Z", { tempC: 22, windKmh: 24.14, windDeg: 200, gustKmh: 40.23, precipLastHourMm: 0 }),
      // A special report in the same hour as a routine one: the larger one counts, not both.
      obs("2026-05-01T13:20:00Z", { precipLastHourMm: 1 }),
      obs("2026-05-01T14:53:00Z", { tempC: 24, windKmh: 8, windDeg: 190, precipLastHourMm: 1.27 }),
      // More than a day before: not in the rain total.
      obs("2026-04-30T12:00:00Z", { precipLastHourMm: 25.4 }),
    ];
    const r = readingAt(list, new Date("2026-05-01T14:00:00Z"));
    expect(r).toEqual({ observedAt: "2026-05-01T13:53:00Z", windMph: 15, windDeg: 200, gustMph: 25, tempF: 71.6, rainIn: 0.14 });
    // Nothing within 90 minutes: not reported yet.
    expect(readingAt(list, new Date("2026-05-01T19:00:00Z"))).toBeNull();
    // No rain reported at all: unknown, not zero.
    expect(readingAt([obs("2026-05-01T13:53:00Z", { tempC: 22 })], new Date("2026-05-01T14:00:00Z"))?.rainIn).toBeNull();
  });

  it("how the wind reads", () => {
    expect(windText({ windMph: 8, windDeg: 200, gustMph: 15 })).toBe("8 mph SSW, gusts 15");
    expect(windText({ windMph: 0 })).toBe("0 mph");
  });

  it("settings and readings", () => {
    expect(weatherSettingsSchema.safeParse({ mode: "sometimes" }).success).toBe(false);
    expect(weatherSettingsSchema.parse({ mode: "manual", windLimitMph: 10 })).toEqual({ mode: "manual" });
    expect(weatherReadingSchema.safeParse({ windMph: "" }).success).toBe(false);
    expect(weatherReadingSchema.parse({ windMph: "7", windDeg: "", tempF: "68", rainIn: "" })).toMatchObject({ windMph: 7, windDeg: null, tempF: 68, rainIn: null });
  });
});
