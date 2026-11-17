import { store as SecureStore } from "@/lib/store";

/**
 * The company last signed in on this phone, so the sign-in screen can show its logo (or name)
 * before anyone signs in (until then, the app doesn't know which company someone belongs to).
 */
export interface LastCompany {
  id: string | null;
  name: string;
  hasLogo: boolean;
  logoUpdatedAt: string | null;
}
const KEY = "crewdesk.lastCompany";
/** Older app versions only kept the name. */
const OLD_KEY = "crewdesk.lastCompanyName";

export async function loadLastCompany(): Promise<LastCompany | null> {
  try {
    const saved = await SecureStore.getItemAsync(KEY);
    if (saved) return JSON.parse(saved) as LastCompany;
    const name = await SecureStore.getItemAsync(OLD_KEY);
    return name ? { id: null, name, hasLogo: false, logoUpdatedAt: null } : null;
  } catch {
    return null;
  }
}

export const saveLastCompany = (c: LastCompany) => SecureStore.setItemAsync(KEY, JSON.stringify(c)).catch(() => {});
