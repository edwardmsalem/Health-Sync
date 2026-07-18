/**
 * Fitbit OAuth 2.0 (PKCE, public client — no secret ships in the app).
 *
 * Setup (one time): register an app at https://dev.fitbit.com/apps with
 * OAuth 2.0 Application Type "Personal" (grants intraday access for your own
 * account) and Redirect URL "healthsync://oauth". Put the Client ID in
 * app.json under expo.extra.fitbitClientId — no code changes needed.
 */

import * as AuthSession from "expo-auth-session";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

export const FITBIT_CLIENT_ID: string =
  (Constants.expoConfig?.extra?.fitbitClientId as string | undefined) ??
  "SET_fitbitClientId_IN_APP_JSON";

const SCOPES = ["activity", "heartrate", "sleep", "weight", "profile", "respiratory_rate", "oxygen_saturation"];
const discovery = {
  authorizationEndpoint: "https://www.fitbit.com/oauth2/authorize",
  tokenEndpoint: "https://api.fitbit.com/oauth2/token",
};
const TOKEN_KEY = "fitbit-token";

interface StoredToken {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms after which accessToken is stale. */
  expiresAt: number;
}

export const redirectUri = AuthSession.makeRedirectUri({ scheme: "healthsync", path: "oauth" });

export function useFitbitAuthRequest() {
  return AuthSession.useAuthRequest(
    {
      clientId: FITBIT_CLIENT_ID,
      scopes: SCOPES,
      redirectUri,
      usePKCE: true,
    },
    discovery,
  );
}

export async function exchangeCode(
  request: AuthSession.AuthRequest,
  code: string,
): Promise<void> {
  const result = await AuthSession.exchangeCodeAsync(
    {
      clientId: FITBIT_CLIENT_ID,
      code,
      redirectUri,
      extraParams: { code_verifier: request.codeVerifier ?? "" },
    },
    discovery,
  );
  await storeToken(result);
}

async function storeToken(result: AuthSession.TokenResponse): Promise<void> {
  const token: StoredToken = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? "",
    expiresAt: Date.now() + (result.expiresIn ?? 28800) * 1000 - 60_000,
  };
  await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(token));
}

export async function isConnected(): Promise<boolean> {
  return (await SecureStore.getItemAsync(TOKEN_KEY)) !== null;
}

export async function disconnect(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/** Valid access token, refreshing through the token endpoint when stale. */
export async function getAccessToken(): Promise<string> {
  const raw = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!raw) throw new Error("Not connected to Fitbit — connect in the app first.");
  const token = JSON.parse(raw) as StoredToken;
  if (Date.now() < token.expiresAt) return token.accessToken;
  const refreshed = await AuthSession.refreshAsync(
    { clientId: FITBIT_CLIENT_ID, refreshToken: token.refreshToken },
    discovery,
  );
  await storeToken(refreshed);
  return refreshed.accessToken;
}

/** The account's UTC offset, needed to interpret Fitbit's local timestamps. */
export async function fetchUtcOffsetMs(): Promise<number> {
  const res = await fetch("https://api.fitbit.com/1/user/-/profile.json", {
    headers: { Authorization: `Bearer ${await getAccessToken()}` },
  });
  if (!res.ok) throw new Error(`Fitbit profile fetch failed (${res.status})`);
  const json = (await res.json()) as { user?: { offsetFromUTCMillis?: number } };
  return json.user?.offsetFromUTCMillis ?? 0;
}
