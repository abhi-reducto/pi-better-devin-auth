/**
 * Pi extension entry point: registers the `devin` provider (Cognition /
 * Windsurf) with browser sign-in, a live model catalog, native streaming,
 * a single-line colored quota footer, and the `/devin-refresh` and
 * `/devin-status` commands.
 */

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import {
  clearCachedCatalog,
  clearCachedQuota,
  clearCachedUserJwt,
  decodeJwtPayload,
  DEFAULT_HOST,
  getCachedCatalog,
  getCachedQuota,
  getCachedUserJwt,
  type DevinQuota,
} from '../src/cloud-direct/index.js';
import { installDevinFooter } from '../src/footer.js';
import { buildLiveModels, FALLBACK_MODELS } from '../src/models.js';
import { loginDevin, renewCredentials } from '../src/oauth/login.js';
import { formatQuotaSummary } from '../src/quota-format.js';
import { streamDevin } from '../src/stream.js';

const PROVIDER_ID = 'devin';
const NOT_SIGNED_IN = 'Devin: not signed in. Run /login devin';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function clearAccountCaches(): void {
  clearCachedUserJwt();
  clearCachedCatalog();
  clearCachedQuota();
}

export default function (pi: ExtensionAPI): void {
  let latestQuota: DevinQuota | undefined;
  let footerHandle: { requestRender: () => void } | undefined;

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
          latestQuota = undefined;
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

  /** Install the single-line colored footer when a Devin model is active; restore default otherwise. */
  const syncFooter = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    if (ctx.model?.provider === PROVIDER_ID) {
      if (!footerHandle) {
        footerHandle = installDevinFooter(pi, ctx, () => latestQuota, PROVIDER_ID);
      }
    } else if (footerHandle) {
      ctx.ui.setFooter(undefined);
      footerHandle = undefined;
    }
  };

  /** Refresh Devin quota and re-render the single-line footer when a Devin model is active. */
  const updateQuotaStatus = async (ctx: ExtensionContext, force = false): Promise<void> => {
    syncFooter(ctx);
    if (!ctx.hasUI || ctx.model?.provider !== PROVIDER_ID) return;
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID).catch(() => undefined);
    if (!apiKey) {
      latestQuota = undefined;
      footerHandle?.requestRender();
      return;
    }
    if (force) clearCachedQuota(apiKey);
    const quota = await getCachedQuota(apiKey).catch(() => undefined);
    if (!quota) return;
    latestQuota = quota;
    footerHandle?.requestRender();
  };

  register(FALLBACK_MODELS);

  // Warm the JWT, catalog, and quota so the first chat turn pays for none of them.
  // Failures are fine: the fallback models stay and the turn mints its own JWT.
  let lastApiKey: string | undefined;
  pi.on('session_start', async (_event, ctx) => {
    footerHandle = undefined;
    syncFooter(ctx);
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID).catch(() => undefined);
    if (!apiKey) {
      latestQuota = undefined;
      return;
    }
    if (lastApiKey && lastApiKey !== apiKey) {
      clearAccountCaches();
      latestQuota = undefined;
    }
    lastApiKey = apiKey;
    await Promise.allSettled([getCachedUserJwt(apiKey), loadLiveModels(apiKey), updateQuotaStatus(ctx)]);
  });

  pi.on('model_select', async (_event, ctx) => {
    await updateQuotaStatus(ctx);
  });

  pi.on('agent_end', async (_event, ctx) => {
    await updateQuotaStatus(ctx);
  });

  pi.registerCommand('devin-refresh', {
    description: 'Refresh Devin model catalog, quota, and JWT from Cognition',
    handler: async (_args, ctx) => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (!apiKey) return ctx.ui.notify(NOT_SIGNED_IN, 'warning');
      clearAccountCaches();
      try {
        const count = await loadLiveModels(apiKey);
        await updateQuotaStatus(ctx, true);
        ctx.ui.notify(`Devin: refreshed ${count} models.`, 'info');
      } catch (e) {
        ctx.ui.notify(`Devin: refresh failed - ${errorText(e)}`, 'error');
      }
    },
  });

  pi.registerCommand('devin-status', {
    description: 'Show Devin auth status, account tier, and remaining quota',
    handler: async (_args, ctx) => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (!apiKey) return ctx.ui.notify(NOT_SIGNED_IN, 'warning');
      try {
        clearCachedQuota(apiKey);
        const [jwtResult, quotaResult] = await Promise.allSettled([
          getCachedUserJwt(apiKey),
          getCachedQuota(apiKey),
        ]);
        if (jwtResult.status === 'rejected') throw jwtResult.reason;
        const claims = decodeJwtPayload(jwtResult.value) ?? {};
        const tier = typeof claims.teams_tier === 'string' ? claims.teams_tier : claims.pro ? 'pro' : 'free';
        const ttl =
          typeof claims.exp === 'number'
            ? `${Math.max(0, Math.round((claims.exp * 1000 - Date.now()) / 60_000))}m`
            : 'unknown';
        const quota = quotaResult.status === 'fulfilled' ? quotaResult.value : undefined;
        if (quota) {
          latestQuota = quota;
          footerHandle?.requestRender();
        }
        const quotaSummary = quota ? formatQuotaSummary(quota) : undefined;
        const details = [`tier=${tier}`, `jwt ttl=${ttl}`, ...(quotaSummary ? [quotaSummary] : [])].join(', ');
        ctx.ui.notify(`Devin: authenticated (${details})`, 'info');
      } catch (e) {
        ctx.ui.notify(`Devin: signed in, but the JWT check failed - ${errorText(e)}`, 'warning');
      }
    },
  });
}
