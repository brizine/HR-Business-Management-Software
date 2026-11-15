import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_PROGRAM, addMonths, describeReviewRule, nextReviewDue, reviewProgramSchema, type ReviewRule } from "../src";

const [ninety, annual] = DEFAULT_REVIEW_PROGRAM.rules;
const emp = (startDate: string | null, employmentType = "full_time") => ({ startDate, employmentType });

describe("review program", () => {
  it("90-day review: due 90 days after hire, reminders inside the window, done by a review", () => {
    const hired = emp("2026-09-01");
    expect(nextReviewDue(ninety, hired, [], "2026-01-01", "2026-10-01")).toMatchObject({ dueDate: "2026-11-30", status: "upcoming", daysLeft: 60 });
    expect(nextReviewDue(ninety, hired, [], "2026-01-01", "2026-11-20")?.status).toBe("due_soon");
    expect(nextReviewDue(ninety, hired, [], "2026-01-01", "2026-12-05")).toMatchObject({ status: "overdue", daysLeft: -5 });
    // A probation review written around then completes it; another type doesn't.
    expect(nextReviewDue(ninety, hired, [{ type: "probation", date: "2026-11-25" }], "2026-01-01", "2026-12-05")).toBeNull();
    expect(nextReviewDue(ninety, hired, [{ type: "annual", date: "2026-11-25" }], "2026-01-01", "2026-12-05")?.status).toBe("overdue");
    // People hired long before the program started aren't chased for a 90-day review.
    expect(nextReviewDue(ninety, emp("2020-03-01"), [], "2026-11-15", "2026-11-15")).toBeNull();
    expect(nextReviewDue(ninety, emp(null), [], "2026-01-01", "2026-11-15")).toBeNull();
  });

  it("annual review on the hire anniversary: the next one after the program started, skipping done ones", () => {
    const vet = emp("2019-04-10");
    expect(nextReviewDue(annual, vet, [], "2026-11-15", "2026-11-15")).toMatchObject({ dueDate: "2027-04-10", status: "upcoming" });
    expect(nextReviewDue(annual, vet, [{ type: "annual", date: "2027-03-20" }], "2026-11-15", "2027-04-01")?.dueDate).toBe("2028-04-10");
    // Overdue stays the same due date until a review is written.
    expect(nextReviewDue(annual, vet, [], "2026-11-15", "2027-05-01")).toMatchObject({ dueDate: "2027-04-10", status: "overdue" });
  });

  it("every N months after the last review, or from a fixed date; employment types", () => {
    const rule: ReviewRule = { ...annual, id: "q", name: "Quarterly check-in", reviewType: "quarterly", months: 3, anchor: "last_review", remindDaysBefore: 7 };
    const e = emp("2026-01-05");
    expect(nextReviewDue(rule, e, [{ type: "quarterly", date: "2026-08-20" }], "2026-01-01", "2026-11-15")).toMatchObject({ dueDate: "2026-11-20", status: "due_soon" });
    expect(nextReviewDue(rule, e, [], "2026-01-01", "2026-03-01")?.dueDate).toBe("2026-04-05");
    const fixed: ReviewRule = { ...annual, id: "f", anchor: "date", anchorDate: "2026-01-15" };
    expect(nextReviewDue(fixed, e, [], "2026-06-01", "2026-06-01")?.dueDate).toBe("2027-01-15");
    const seasonalOnly: ReviewRule = { ...annual, employmentTypes: ["seasonal"] };
    expect(nextReviewDue(seasonalOnly, e, [], "2026-01-01", "2026-06-01")).toBeNull();
    expect(nextReviewDue({ ...annual, active: false }, e, [], "2026-01-01", "2026-06-01")).toBeNull();
  });

  it("month arithmetic keeps the day, or the month's last day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-02-29", 12)).toBe("2025-02-28");
    expect(addMonths("2026-03-15", 12)).toBe("2027-03-15");
  });

  it("validates and describes rules", () => {
    expect(reviewProgramSchema.safeParse(DEFAULT_REVIEW_PROGRAM).success).toBe(true);
    expect(reviewProgramSchema.safeParse({ ...DEFAULT_REVIEW_PROGRAM, rules: [{ ...ninety, days: undefined }] }).success).toBe(false);
    expect(describeReviewRule(ninety)).toBe("90 days after hire");
    expect(describeReviewRule(annual)).toBe("Every year from the hire date");
  });
});
