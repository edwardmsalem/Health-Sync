/** Nightscout connection settings, stored in the iOS keychain. */

import * as SecureStore from "expo-secure-store";

const URL_KEY = "nightscout-url";
const TOKEN_KEY = "nightscout-token";

export interface NightscoutConfig {
  /** Base URL, e.g. https://ns.example.com (no trailing slash needed). */
  url: string;
  /** Access token (or empty for open read-enabled sites). */
  token: string;
}

export async function getNightscoutConfig(): Promise<NightscoutConfig | null> {
  const url = await SecureStore.getItemAsync(URL_KEY);
  if (!url) return null;
  return { url, token: (await SecureStore.getItemAsync(TOKEN_KEY)) ?? "" };
}

export async function setNightscoutConfig(cfg: NightscoutConfig | null): Promise<void> {
  if (!cfg) {
    await SecureStore.deleteItemAsync(URL_KEY);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    return;
  }
  await SecureStore.setItemAsync(URL_KEY, cfg.url.replace(/\/+$/, ""));
  await SecureStore.setItemAsync(TOKEN_KEY, cfg.token);
}
