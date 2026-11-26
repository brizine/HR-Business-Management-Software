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

import { forecastIcon, weatherLinkSchema, weatherLinksSchema, windTopMph } from "../src/weather";

describe("the forecast box", () => {
  it("draws the Weather Service's icons with its own pictures, the worst weather winning", () => {
    const icon = (path: string, day = true) => forecastIcon(`https://api.weather.gov/icons/land/${day ? "day" : "night"}/${path}?size=medium`, day);
    expect(icon("skc")).toBe("sun");
    expect(icon("few", false)).toBe("moon");
    expect(icon("sct")).toBe("partly");
    expect(icon("sct", false)).toBe("partly-night");
    expect(icon("bkn")).toBe("cloud");
    expect(icon("ovc", false)).toBe("cloud");
    expect(icon("rain_showers,40")).toBe("rain");
    expect(icon("rain_showers,30/tsra,60")).toBe("storm");
    expect(icon("tsra_hi,20/sct")).toBe("storm");
    expect(icon("snow,50")).toBe("snow");
    expect(icon("fzra,30")).toBe("snow");
    expect(icon("fog")).toBe("fog");
    expect(icon("wind_few")).toBe("wind");
    expect(icon("wind_bkn")).toBe("cloud");
    expect(icon("hot")).toBe("sun");
    expect(forecastIcon(null, false)).toBe("moon");
    expect(forecastIcon("", true)).toBe("sun");
  });

  it("reads the top of the wind range", () => {
    expect(windTopMph("7 to 12 mph")).toBe(12);
    expect(windTopMph("5 mph")).toBe(5);
    expect(windTopMph("")).toBeNull();
    expect(windTopMph(null)).toBeNull();
  });

  it("weather links are web addresses with a name", () => {
    expect(weatherLinkSchema.parse({ label: " Mesonet ", url: "www.mesonet.org" })).toEqual({ label: "Mesonet", url: "https://www.mesonet.org" });
    expect(weatherLinkSchema.parse({ label: "Radar", url: "http://radar.weather.gov/x?y=1" }).url).toBe("http://radar.weather.gov/x?y=1");
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://a.example", "localhost", "", "mailto:a@b.co"]) expect(weatherLinkSchema.safeParse({ label: "x", url }).success).toBe(false);
    expect(weatherLinkSchema.safeParse({ label: "", url: "https://a.example" }).success).toBe(false);
    expect(weatherLinksSchema.safeParse({ links: Array.from({ length: 13 }, () => ({ label: "x", url: "a.example" })) }).success).toBe(false);
    expect(weatherLinksSchema.parse({ links: [] })).toEqual({ links: [] });
  });
});
