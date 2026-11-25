/**
 * Types for the Windsurf sign-in flow.
 *
 * Two tokens are involved:
 *   - the Firebase ID token: a short-lived JWT the sign-in page shows the
 *     user. It is exchanged once and discarded.
 *   - the API key: the long-lived credential `RegisterUser` returns
 *     (`devin-session-token$<JWT>` today). It is opaque to this extension and
 *     is sent as `Metadata.api_key` on every RPC.
 */

export interface RegisteredUser {
  apiKey: string;
  /** Account display name. */
  name: string;
  /** The tenant's API server; `https://server.codeium.com` for personal accounts. */
  apiServerUrl: string;
}

export interface WindsurfRegion {
  /** Where the browser sign-in page lives. */
  website: string;
  /** Base URL of the `RegisterUser` RPC. */
  registerApiServerUrl: string;
  /** Auth0 client id passed in the sign-in URL. */
  oauthClientId: string;
}

/** The personal / single-tenant region. */
export const DEFAULT_REGION: WindsurfRegion = {
  website: 'https://windsurf.com',
  registerApiServerUrl: 'https://register.windsurf.com',
  // Windsurf's public Auth0 client id, from its extension.js. Sign-in breaks
  // if Windsurf rotates it, until it is re-extracted.
  oauthClientId: '3GUryQ7ldAeKEuD2obYnppsnmj58eP5u',
};
