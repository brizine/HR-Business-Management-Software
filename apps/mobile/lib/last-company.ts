import * as SecureStore from "expo-secure-store";

/**
 * The name of the company last signed in on this phone, so the sign-in screen can show it
 * (before signing in, the app doesn't know which company someone belongs to).
 */
const KEY = "crewdesk.lastCompanyName";

export const loadLastCompanyName = () => SecureStore.getItemAsync(KEY).catch(() => null);
export const saveLastCompanyName = (name: string) => SecureStore.setItemAsync(KEY, name).catch(() => {});
