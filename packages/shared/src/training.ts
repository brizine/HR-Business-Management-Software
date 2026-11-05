import { z } from "zod";

/**
 * Training (like Frappe Learning): courses made of lessons, grouped into chapters. A lesson has
 * text (wiki formatting), an optional video and an optional quiz. People are assigned a course (by
 * a manager, automatically by job title, or they enrol themselves), work through the lessons, and
 * finish when every lesson is done and every quiz passed. Courses can expire (e.g. yearly safety
 * training) so people are assigned again.
 */
export const QUESTION_KINDS = ["single", "multiple", "true_false"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const quizQuestionSchema = z
  .object({
    kind: z.enum(QUESTION_KINDS),
    question: z.string().trim().min(1, "Write the question").max(1000),
    options: z.array(z.string().trim().min(1, "Options can't be blank").max(300)).min(2, "Add at least two options").max(8),
    /** Indexes of the right options. */
    correct: z.array(z.number().int().min(0)).min(1, "Mark the right answer"),
    /** Shown after answering. */
    explanation: z.string().trim().max(1000).optional(),
  })
  .refine((q) => q.correct.every((i) => i < q.options.length), { message: "A right answer points to an option that doesn't exist", path: ["correct"] })
  .refine((q) => q.kind === "multiple" || q.correct.length === 1, { message: "Pick exactly one right answer", path: ["correct"] })
  .refine((q) => q.kind !== "true_false" || q.options.length === 2, { message: "True/false questions have two options", path: ["options"] });
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;

/** Who a course is assigned to automatically. */
export const AUTO_ASSIGN = ["none", "everyone", "titles", "departments"] as const;

export const courseSchema = z.object({
  title: z.string().trim().min(1, "Give the course a title").max(150),
  description: z.string().trim().max(5000).optional().transform((v) => v || null),
  category: z.string().trim().max(60).optional().transform((v) => v || null),
  /** Draft courses are only visible to people who manage training. */
  published: z.boolean(),
  /** Quizzes must be passed with at least this score. */
  passingScore: z.number().int().min(0).max(100),
  /** Completion lasts this many months, then they're assigned again (null = never expires). */
  validityMonths: z.number().int().min(1).max(120).nullable(),
  /** Days after assignment that it's due (null = no due date). */
  dueDays: z.number().int().min(1).max(365).nullable(),
  autoAssign: z.enum(AUTO_ASSIGN),
  /** Job titles or departments for autoAssign "titles" / "departments". */
  autoAssignTo: z.array(z.string().trim().min(1).max(120)).max(50),
  /** Anyone can enrol themselves in a published course. */
  selfEnroll: z.boolean(),
});
export type CourseInput = z.infer<typeof courseSchema>;

export const lessonSchema = z.object({
  /** Chapter heading this lesson sits under. */
  chapter: z.string().trim().max(120).optional().transform((v) => v || null),
  title: z.string().trim().min(1, "Give the lesson a title").max(150),
  content: z.string().max(100_000),
  /** YouTube, Vimeo or a direct video link. */
  videoUrl: z.string().trim().max(500).url("Enter a full video link (https://…)").nullable().optional().or(z.literal("")).transform((v) => v || null),
  quiz: z.array(quizQuestionSchema).max(50),
});
export type LessonInput = z.infer<typeof lessonSchema>;

export const quizSubmitSchema = z.object({ answers: z.array(z.array(z.number().int().min(0))).max(50) });
export const assignSchema = z.object({
  employeeIds: z.array(z.string().uuid()).min(1).max(500),
  /** Overrides the course's usual due date. */
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

/** Grades answers: each question is right only if exactly the right options are chosen. */
export function gradeQuiz(quiz: QuizQuestion[], answers: number[][]) {
  const results = quiz.map((q, i) => {
    const given = [...new Set(answers[i] ?? [])].sort();
    const right = [...q.correct].sort();
    return given.length === right.length && given.every((v, j) => v === right[j]);
  });
  const correct = results.filter(Boolean).length;
  return { results, correct, total: quiz.length, score: quiz.length ? Math.round((correct / quiz.length) * 100) : 100 };
}

/** A quiz with the answers taken out, for learners. */
export const quizForLearner = (quiz: QuizQuestion[]) => quiz.map(({ kind, question, options }) => ({ kind, question, options }));

export type EnrollmentStatus = "not_started" | "in_progress" | "completed" | "overdue" | "expired";
export const ENROLLMENT_STATUS_LABELS: Record<EnrollmentStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
  overdue: "Overdue",
  expired: "Expired: needs retaking",
};

/** Where someone is with a course. */
export function enrollmentStatus(e: { completedAt: string | Date | null; expiresAt: string | null; dueDate: string | null; lessonsDone: number }, today: string): EnrollmentStatus {
  if (e.completedAt) return e.expiresAt && e.expiresAt <= today ? "expired" : "completed";
  if (e.dueDate && e.dueDate < today) return "overdue";
  return e.lessonsDone > 0 ? "in_progress" : "not_started";
}

/** The date a completion expires ("YYYY-MM-DD"), or null. */
export function completionExpiry(completedOn: string, validityMonths: number | null): string | null {
  if (!validityMonths) return null;
  const [y, m, d] = completedOn.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + validityMonths, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** An embeddable player address for YouTube / Vimeo links (null: link out instead). */
export function videoEmbedUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtube.com" && u.searchParams.get("v")) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(u.searchParams.get("v")!)}`;
    if (host === "youtube.com" && u.pathname.startsWith("/shorts/")) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(u.pathname.split("/")[2])}`;
    if (host === "youtu.be") return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(u.pathname.slice(1))}`;
    if (host === "vimeo.com" && /^\/\d+/.test(u.pathname)) return `https://player.vimeo.com/video/${u.pathname.split("/")[1]}`;
  } catch {
    return null;
  }
  return null;
}
