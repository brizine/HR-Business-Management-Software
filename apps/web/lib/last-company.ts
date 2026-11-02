/**
 * The name of the company last signed in on this browser, so the sign-in page can show it
 * (before signing in, the site doesn't know which company someone belongs to).
 */
const KEY = "crewdesk.lastCompanyName";

export function loadLastCompanyName(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveLastCompanyName(name: string) {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // Storage blocked (e.g. private browsing): the sign-in page just says "Sign in".
  }
}
