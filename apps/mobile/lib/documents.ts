import { Linking } from "react-native";
import { API_URL, api } from "./api";

/** Opens a document on the phone (PDF, photo…) through a link that works for 5 minutes. */
export async function openDocument(id: string) {
  const { path } = await api<{ path: string }>(`/documents/${id}/link`, { method: "POST" });
  await Linking.openURL(API_URL + path);
}
