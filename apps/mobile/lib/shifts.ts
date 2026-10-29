export const shiftDay = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });

export const shiftTimes = (s: { startsAt: string; endsAt: string }) => {
  const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${t(s.startsAt)} – ${t(s.endsAt)}`;
};
