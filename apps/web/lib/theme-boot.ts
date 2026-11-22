/** Shared by the root layout (server) and lib/theme.ts (browser), so it can't be a client module. */
export const THEME_KEY = "crewdesk.theme";

/** Runs inline in <head> before anything renders: applies a saved Light or Dark choice (keep in step with lib/theme.ts). */
export const THEME_BOOT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
