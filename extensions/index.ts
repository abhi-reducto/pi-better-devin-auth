/**
 * Pi extension entry point: registers the `devin` provider (Cognition /
 * Windsurf) with browser sign-in, a live model catalog and native streaming,
 * plus the `/devin-refresh` and `/devin-status` commands.
 */

import type { ExtensionAPI, ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import {
  clearCachedCatalog,
  clearCachedUserJwt,
  decodeJwtPayload,
  DEFAULT_HOST,
  getCachedCatalog,
  getCachedUserJwt,
} from '../src/cloud-direct/index.js';
import { buildLiveModels, FALLBACK_MODELS } from '../src/models.js';
import { loginDevin, renewCredentials } from '../src/oauth/login.js';
import { streamDevin } from '../src/stream.js';

const PROVIDER_ID = 'devin';
const NOT_SIGNED_IN = 'Devin: not signed in. Run /login devin';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function clearAccountCaches(): void {
  clearCachedUserJwt();
  clearCachedCatalog();
}

export default function (pi: ExtensionAPI): void {
  /** Pi replaces a provider's model list by registering the provider again. */
  const register = (models: ProviderModelConfig[]): void => {
    pi.registerProvider(PROVIDER_ID, {
      name: 'Devin (Cognition)',
      api: 'devin-cloud',
      baseUrl: DEFAULT_HOST,
      models,
      streamSimple: streamDevin,
      async refreshModels(context) {
        const cred = context.credential;
        const apiKey = cred?.type === 'oauth' ? cred.access : cred?.key;
        if (!apiKey || !context.allowNetwork) return FALLBACK_MODELS;
        if (context.force) clearCachedCatalog();
        const catalog = await getCachedCatalog(apiKey, context.baseUrl, context.signal).catch(() => null);
        return catalog ? buildLiveModels(catalog) : FALLBACK_MODELS;
      },
      oauth: {
        name: 'Devin (Cognition / Windsurf)',
        isSubscription: true,
        async login(callbacks) {
          const credentials = await loginDevin(callbacks);
          clearAccountCaches();
          await loadLiveModels(credentials.access).catch(() => {});
          return credentials;
        },
        refreshToken: async (credentials) => renewCredentials(credentials),
        getApiKey: (credentials) => credentials.access,
      },
    });
  };

  /** Fetch the account's catalog and register its models. Rejects if the fetch fails. */
  const loadLiveModels = async (apiKey: string): Promise<number> => {
    const models = buildLiveModels(await getCachedCatalog(apiKey));
    register(models);
    return models.length;
  };

  register(FALLBACK_MODELS);

  // Warm the JWT and the catalog so the first chat turn pays for neither.
  // Failures are fine: the fallback models stay and the turn mints its own JWT.
  let lastApiKey: string | undefined;
  pi.on('session_start', async (_event, ctx) => {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID).catch(() => undefined);
    if (!apiKey) return;
    if (lastApiKey && lastApiKey !== apiKey) clearAccountCaches();
    lastApiKey = apiKey;
    await Promise.allSettled([getCachedUserJwt(apiKey), loadLiveModels(apiKey)]);
  });

  pi.registerCommand('devin-refresh', {
    description: 'Refresh Devin model catalog and JWT from Cognition',
    handler: async (_args, ctx) => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (!apiKey) return ctx.ui.notify(NOT_SIGNED_IN, 'warning');
      clearAccountCaches();
      try {
        ctx.ui.notify(`Devin: refreshed ${await loadLiveModels(apiKey)} models.`, 'info');
      } catch (e) {
        ctx.ui.notify(`Devin: refresh failed - ${errorText(e)}`, 'error');
      }
    },
  });

  pi.registerCommand('devin-status', {
    description: 'Show Devin auth status and account tier',
    handler: async (_args, ctx) => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (!apiKey) return ctx.ui.notify(NOT_SIGNED_IN, 'warning');
      try {
        const claims = decodeJwtPayload(await getCachedUserJwt(apiKey)) ?? {};
        const tier = typeof claims.teams_tier === 'string' ? claims.teams_tier : claims.pro ? 'pro' : 'free';
        const ttl =
          typeof claims.exp === 'number'
            ? `${Math.max(0, Math.round((claims.exp * 1000 - Date.now()) / 60_000))}m`
            : 'unknown';
        ctx.ui.notify(`Devin: authenticated (tier=${tier}, jwt ttl=${ttl})`, 'info');
      } catch (e) {
        ctx.ui.notify(`Devin: signed in, but the JWT check failed - ${errorText(e)}`, 'warning');
      }
    },
  });
}
