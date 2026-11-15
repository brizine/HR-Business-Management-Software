import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Small key/value storage: the phone's secure storage on iOS/Android, and the browser's
 * localStorage in the web preview (secure storage doesn't exist in a browser).
 */
const web = Platform.OS === "web";
export const store = {
  async getItemAsync(key: string): Promise<string | null> {
    if (web) { try { return localStorage.getItem(key); } catch { return null; } }
    return SecureStore.getItemAsync(key);
  },
  async setItemAsync(key: string, value: string) {
    if (web) { try { localStorage.setItem(key, value); } catch { /* private window */ } return; }
    await SecureStore.setItemAsync(key, value);
  },
  async deleteItemAsync(key: string) {
    if (web) { try { localStorage.removeItem(key); } catch { /* ignore */ } return; }
    await SecureStore.deleteItemAsync(key);
  },
};
