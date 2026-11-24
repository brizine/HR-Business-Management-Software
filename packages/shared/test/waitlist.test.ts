import { describe, expect, it } from "vitest";
import { eligibleFrom, historyMinutes, sizeMinutes, waitBadges, waitBulkSchema, waitScheduleSchema } from "../src";

describe("waiting list rules", () => {
  it("eligible from: the release date or the last service plus the minimum days, whichever is later", () => {
    expect(eligibleFrom({ releaseOn: null, minDaysAfterLast: null, lastServiceOn: "2026-04-01" })).toBeNull();
    expect(eligibleFrom({ releaseOn: "2026-04-15", minDaysAfterLast: null, lastServiceOn: null })).toBe("2026-04-15");
    expect(eligibleFrom({ releaseOn: "2026-04-15", minDaysAfterLast: 21, lastServiceOn: "2026-04-10" })).toBe("2026-05-01");
    expect(eligibleFrom({ releaseOn: "2026-05-15", minDaysAfterLast: 21, lastServiceOn: "2026-04-10" })).toBe("2026-05-15");
    expect(eligibleFrom({ releaseOn: null, minDaysAfterLast: 21, lastServiceOn: "2026-04-10" })).toBe("2026-05-01");
  });

  it("badges: missed, closing, too early, needs card, dog, notify and priority", () => {
    const base = { today: "2026-05-01", dueBy: null, eligible: null, needsCard: false, pets: null, notify: "none" as const, priority: "normal" as const };
    expect(waitBadges(base)).toEqual([]);
    expect(waitBadges({ ...base, dueBy: "2026-04-30" })).toEqual(["missed"]);
    expect(waitBadges({ ...base, dueBy: "2026-05-08" })).toEqual(["closing"]);
    expect(waitBadges({ ...base, dueBy: "2026-05-09" })).toEqual([]);
    expect(waitBadges({ ...base, eligible: "2026-05-03", needsCard: true, pets: "2 dogs, friendly", notify: "text", priority: "high" }))
      .toEqual(["early", "needs_card", "high", "dog", "text_ahead"]);
    expect(waitBadges({ ...base, pets: "cat" })).toEqual([]);
  });

  it("time estimates: from size, then the property's history", () => {
    expect(sizeMinutes({ setupMinutes: 5, minutesPer1000: 3 }, 10000)).toBe(35);
    expect(sizeMinutes({ setupMinutes: null, minutesPer1000: null }, 10000)).toBeNull();
    // One visit: half and half with the size estimate.
    expect(historyMinutes([45], 35)).toEqual({ minutes: 40, used: 1, leftOut: 0 });
    // Three or more: the history alone, recent ones counting more.
    expect(historyMinutes([40, 30, 30], 99).minutes).toBe(35);
    // A breakdown (200 min) is left out.
    expect(historyMinutes([30, 200, 30, 32], 35)).toMatchObject({ used: 3, leftOut: 1 });
    expect(historyMinutes([], 35).minutes).toBeNull();
  });

  it("schedule and bulk requests", () => {
    const id = "8b0c5a3e-2f6b-4b7a-9d55-1c2e3f4a5b6c";
    expect(waitScheduleSchema.safeParse({ visitIds: [], date: "2026-05-02" }).success).toBe(false);
    expect(waitScheduleSchema.parse({ visitIds: [id], date: "2026-05-02", crewId: "" })).toMatchObject({ crewId: null, notify: false });
    expect(waitBulkSchema.safeParse({ visitIds: [id], action: "skip" }).success).toBe(false);
    expect(waitBulkSchema.safeParse({ visitIds: [id], action: "priority", priority: "high" }).success).toBe(true);
  });
});
