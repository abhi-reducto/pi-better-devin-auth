/**
 * Browser sign-in to Windsurf through Pi's `OAuthLoginCallbacks`.
 *
 *   1. Open Windsurf's sign-in page with `redirect_uri=show-auth-token`,
 *      which makes the page display the resulting token instead of
 *      redirecting. (Pi's login callbacks cannot receive a redirect, so the
 *      user copies the token by hand.)
 *   2. The user pastes that token: a short-lived Firebase ID token.
 *   3. `registerUser` exchanges it for the long-lived API key Pi stores.
 */

import * as crypto from 'node:crypto';
import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import { registerUser } from './register-user.js';
import { DEFAULT_REGION, type WindsurfRegion } from './types.js';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Windsurf API keys do not expire and have no refresh token. Pi's credential
 * shape requires an expiry, so the key is stored with a rolling one-year
 * expiry that {@link renewCredentials} extends.
 */
function credentialsFor(apiKey: string): OAuthCredentials {
  return { refresh: '', access: apiKey, expires: Date.now() + ONE_YEAR_MS };
}

export function renewCredentials(credentials: OAuthCredentials): OAuthCredentials {
  return credentialsFor(credentials.access);
}

function signInUrl(region: WindsurfRegion): string {
  const params = new URLSearchParams({
    response_type: 'token', // implicit grant: no client secret
    client_id: region.oauthClientId,
    redirect_uri: 'show-auth-token',
    state: crypto.randomUUID(), // required by Auth0; never returned to us
    prompt: 'login', // always show the login screen, so the account can be chosen
  });
  return `${region.website}/windsurf/signin?${params}`;
}

export async function loginDevin(
  callbacks: OAuthLoginCallbacks,
  region: WindsurfRegion = DEFAULT_REGION,
): Promise<OAuthCredentials> {
  callbacks.onAuth({ url: signInUrl(region) });
  const pasted = await callbacks.onPrompt({ message: 'Paste the token from the sign-in page:' });
  const firebaseIdToken = pasted?.trim();
  if (!firebaseIdToken) throw new Error('No token pasted; cannot complete sign-in.');

  const { apiKey } = await registerUser(firebaseIdToken, region, callbacks.signal);
  return credentialsFor(apiKey);
}
