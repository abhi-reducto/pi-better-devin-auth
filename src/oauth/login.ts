/**
 * Browser sign-in to Windsurf through Pi's `OAuthLoginCallbacks`.
 *
 * Since Cognition rebranded Windsurf, the old OAuth redirect flow is no
 * longer reliable from a browser: Devin rejects the old `redirect_uri`,
 * `/show-auth-token` tries to launch Devin Desktop, and the manual
 * Vim/Neovim page now redirects to the Devin download page.
 *
 * The most reliable path is to reuse an already-authenticated Devin CLI.
 * If the Devin CLI has run `devin auth login`, its credentials file
 * contains the long-lived `devin-session-token` API key that Pi needs.
 * We extract it directly and skip the browser flow entirely.
 *
 *   1. Read ~/.local/share/devin/credentials.toml (Devin CLI default).
 *   2. Use the `windsurf_api_key` field as the long-lived API key.
 *   3. If no CLI credentials exist, fall back to the manual browser page
 *      and paste the token.
 *   4. `registerUser` exchanges the pasted Firebase ID token for the
 *      API key only in the fallback path.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Locate the Devin CLI credentials file. The CLI currently stores it at
 * `~/.local/share/devin/credentials.toml` on Linux and similarly on
 * macOS/Windows.
 */
function devinCliCredentialsPath(): string | undefined {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) return undefined;
    return join(appData, 'devin', 'credentials.toml');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'devin', 'credentials.toml');
  }
  // Linux and other Unix-like systems
  return join(homedir(), '.local', 'share', 'devin', 'credentials.toml');
}

/**
 * Parse the simple TOML credentials file the Devin CLI writes.
 * It only contains a few string keys, so a small regex is enough.
 */
function parseDevinCliCredentials(): { apiKey: string; apiServerUrl?: string } | undefined {
  const path = devinCliCredentialsPath();
  if (!path) return undefined;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  const apiKeyMatch = text.match(/^windsurf_api_key\s*=\s*"([^"]+)"/m);
  if (!apiKeyMatch) return undefined;

  const apiServerUrlMatch = text.match(/^api_server_url\s*=\s*"([^"]+)"/m);
  return {
    apiKey: apiKeyMatch[1]!,
    apiServerUrl: apiServerUrlMatch ? apiServerUrlMatch[1] : undefined,
  };
}

function signInUrl(region: WindsurfRegion): string {
  // Last known manual-token page. Cognition keeps redirecting this, so the
  // primary path is to reuse the Devin CLI credentials above.
  return `${region.website}/enterprise/account/login?redirect_uri=vim-show-auth-token`;
}

export async function loginDevin(
  callbacks: OAuthLoginCallbacks,
  region: WindsurfRegion = DEFAULT_REGION,
): Promise<OAuthCredentials> {
  const cliCredentials = parseDevinCliCredentials();
  if (cliCredentials) {
    callbacks.onProgress?.('Reusing existing Devin CLI credentials.');
    return credentialsFor(cliCredentials.apiKey);
  }

  callbacks.onAuth({ url: signInUrl(region) });
  const pasted = await callbacks.onPrompt({ message: 'Paste the token from the sign-in page:' });
  const firebaseIdToken = pasted?.trim();
  if (!firebaseIdToken) throw new Error('No token pasted; cannot complete sign-in.');

  const { apiKey } = await registerUser(firebaseIdToken, region, callbacks.signal);
  return credentialsFor(apiKey);
}
