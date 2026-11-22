"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { NAV } from "@/lib/nav";
import { UNNAMED, currentTitle, nameCurrent, setTrailScope, useTrail, visit } from "@/lib/trail";

/** What a page is called before it says so itself: its menu name, if it has one. */
function menuName(path: string) {
  for (const groups of Object.values(NAV)) for (const g of groups) for (const i of g.items) if (i.href === path) return i.label;
  const named: Record<string, string> = { "/": "Home", "/notifications": "Notifications", "/help": "Help", "/wiki": "Company Wiki" };
  return named[path] ?? UNNAMED;
}

/**
 * The breadcrumb trail at the top of every page: your last few pages, oldest first, then this one.
 * Click any of them to go back to it.
 */
export function Trail() {
  const { me } = useAuth();
  const path = usePathname();
  const trail = useTrail();
  const timers = useRef<number[]>([]);
  const nav = useRef<HTMLElement>(null);
  // On a narrow screen the newest pages (at the end) stay in view; older ones scroll off to the left.
  useEffect(() => { if (nav.current) nav.current.scrollLeft = nav.current.scrollWidth; }, [trail]);
  useEffect(() => { if (me) setTrailScope(`${me.user.id}.${me.company.id}`); }, [me]);
  useEffect(() => {
    if (!me || !path) return;
    visit(path, path + window.location.search, menuName(path));
    // Pages without a title of their own: use their main heading once it's on the page.
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [400, 1500].map((ms) => window.setTimeout(() => {
      if (currentTitle() !== UNNAMED) return;
      const h = document.querySelector("main h1");
      if (h?.textContent) nameCurrent(path, h.textContent);
    }, ms));
    return () => { for (const t of timers.current) window.clearTimeout(t); };
  }, [path, me]);
  if (!trail.length) return null;
  return (
    <nav aria-label="Recently visited pages" className="trail" ref={nav}>
      <ol>
        {trail.map((e, i) => (
          <li key={e.key}>
            {i < trail.length - 1
              ? <Link href={e.href} title={e.title}>{e.title}</Link>
              : <span aria-current="page" title={e.title}>{e.title}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
