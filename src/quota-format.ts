/**
 * Formatting helpers for the colored single-line Devin footer (token stats +
 * remaining quota + model/thinking on one line) and for `/devin-status`.
 */

import type { DevinQuota } from './cloud-direct/index.js';

export type QuotaTone = 'success' | 'warning' | 'error';

export type StatusColor =
  | 'accent'
  | 'dim'
  | 'muted'
  | 'text'
  | 'success'
  | 'warning'
  | 'error'
  | 'syntaxKeyword'
  | 'syntaxFunction'
  | 'syntaxNumber'
  | 'syntaxString'
  | 'thinkingOff'
  | 'thinkingMinimal'
  | 'thinkingLow'
  | 'thinkingMedium'
  | 'thinkingHigh'
  | 'thinkingXhigh'
  | 'thinkingMax';

export interface StatusTheme {
  fg(color: StatusColor, text: string): string;
  bold(text: string): string;
}

export interface SessionFooterStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
  contextPercent: number | null;
  contextWindow: number;
  usingSubscription: boolean;
}

export interface FooterRightMeta {
  provider?: string;
  modelId: string;
  thinkingLevel?: string;
  showProvider: boolean;
}

/** Format token counts compactly (matches Pi's built-in footer). */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Pick a semantic color for a remaining-quota percentage. */
export function quotaTone(remainingPercent: number): QuotaTone {
  if (remainingPercent <= 10) return 'error';
  if (remainingPercent <= 25) return 'warning';
  return 'success';
}

/** Pick a semantic color for context window usage percentage. */
export function contextTone(usedPercent: number): QuotaTone {
  if (usedPercent > 85) return 'error';
  if (usedPercent > 65) return 'warning';
  return 'success';
}

/** Compact remaining-time string such as `3d 4h`, `5h 12m`, or `18m`. */
export function formatResetIn(resetAtUnix: number | undefined, nowMs = Date.now()): string | undefined {
  if (resetAtUnix === undefined) return undefined;
  const diffSec = Math.max(0, Math.floor(resetAtUnix - nowMs / 1000));
  if (diffSec === 0) return 'now';
  const days = Math.floor(diffSec / 86_400);
  const hours = Math.floor((diffSec % 86_400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${Math.max(1, mins)}m`;
}

/** Small Unicode progress bar (e.g. `█████░`) representing remaining quota. */
export function quotaBar(remainingPercent: number, width = 6): string {
  const clamped = Math.max(0, Math.min(100, remainingPercent));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const THINKING_COLOR: Readonly<Record<string, StatusColor>> = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax',
};

/** Format a compact, colored Devin quota segment (for inline footer or `setStatus`). */
export function formatQuotaSegment(
  quota: DevinQuota,
  theme: StatusTheme,
  nowMs = Date.now(),
  compact = false,
): string | undefined {
  const parts: string[] = [];

  if (!compact) {
    const badge = quota.planName ? `Devin ${quota.planName}` : 'Devin';
    parts.push(theme.bold(theme.fg('accent', badge)));
  }

  const showDaily = !quota.hideDailyQuota && quota.dailyRemainingPercent !== undefined;
  const showWeekly = !quota.hideWeeklyQuota && quota.weeklyRemainingPercent !== undefined;
  const barWidth = compact ? 5 : 6;

  if (showDaily) {
    const pct = Math.round(quota.dailyRemainingPercent!);
    const tone = quotaTone(pct);
    const reset = formatResetIn(quota.dailyResetAtUnix, nowMs);
    const suffix = reset ? theme.fg('dim', ` (${reset})`) : '';
    parts.push(`${theme.fg('muted', 'day ')}${theme.fg(tone, `${quotaBar(pct, barWidth)} ${pct}%`)}${suffix}`);
  }

  if (showWeekly) {
    const pct = Math.round(quota.weeklyRemainingPercent!);
    const tone = quotaTone(pct);
    const reset = formatResetIn(quota.weeklyResetAtUnix, nowMs);
    const suffix = reset ? theme.fg('dim', ` (${reset})`) : '';
    parts.push(`${theme.fg('muted', 'wk ')}${theme.fg(tone, `${quotaBar(pct, barWidth)} ${pct}%`)}${suffix}`);
  }

  if (!showDaily && !showWeekly && quota.availablePromptCredits !== undefined && quota.availablePromptCredits > 0) {
    const used = quota.usedPromptCredits ?? 0;
    const remaining = Math.max(0, quota.availablePromptCredits - used);
    const pct = Math.round((remaining / quota.availablePromptCredits) * 100);
    parts.push(
      `${theme.fg('muted', 'credits ')}${theme.fg(quotaTone(pct), `${remaining}/${quota.availablePromptCredits}`)}`,
    );
  }

  if (quota.overageBalanceUsd !== undefined && quota.overageBalanceUsd > 0) {
    parts.push(theme.fg('syntaxString', `+$${quota.overageBalanceUsd.toFixed(2)}`));
  }

  const minParts = compact ? 1 : 2;
  if (parts.length < minParts) return undefined;
  return parts.join(theme.fg('dim', ' · '));
}

/** Backwards-compatible alias for `formatQuotaSegment`. */
export function formatQuotaFooter(
  quota: DevinQuota,
  theme: StatusTheme,
  nowMs = Date.now(),
): string | undefined {
  return formatQuotaSegment(quota, theme, nowMs, false);
}

/** Format the colored left-hand stats + optional inline Devin quota segment. */
export function formatStatsLeft(
  stats: SessionFooterStats,
  quota: DevinQuota | undefined,
  theme: StatusTheme,
  nowMs = Date.now(),
  compactQuota = false,
): string {
  const parts: string[] = [];

  if (stats.input) parts.push(theme.fg('syntaxFunction', `↑${formatTokens(stats.input)}`));
  if (stats.output) parts.push(theme.fg('syntaxKeyword', `↓${formatTokens(stats.output)}`));
  if (stats.cacheRead) parts.push(theme.fg('accent', `R${formatTokens(stats.cacheRead)}`));
  if (stats.cacheWrite) parts.push(theme.fg('warning', `W${formatTokens(stats.cacheWrite)}`));

  if ((stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.latestCacheHitRate !== undefined) {
    const chTone: StatusColor =
      stats.latestCacheHitRate >= 80 ? 'success' : stats.latestCacheHitRate >= 50 ? 'warning' : 'muted';
    parts.push(theme.fg(chTone, `CH${stats.latestCacheHitRate.toFixed(1)}%`));
  }

  if (stats.cost > 0 || stats.usingSubscription) {
    const amount = theme.fg('syntaxNumber', `$${stats.cost.toFixed(3)}`);
    const sub = stats.usingSubscription ? theme.fg('dim', ' (sub)') : '';
    parts.push(`${amount}${sub}`);
  }

  const ctxLabel =
    stats.contextPercent !== null
      ? `${stats.contextPercent.toFixed(1)}%/${formatTokens(stats.contextWindow)}`
      : `?/${formatTokens(stats.contextWindow)}`;
  const ctxColor: StatusColor = stats.contextPercent !== null ? contextTone(stats.contextPercent) : 'muted';
  parts.push(theme.fg(ctxColor, ctxLabel));

  if (quota) {
    const quotaText = formatQuotaSegment(quota, theme, nowMs, compactQuota);
    if (quotaText) parts.push(`${theme.fg('dim', '│')} ${quotaText}`);
  }

  return parts.join(' ');
}

/** Format the colored right-hand model + thinking level indicator. */
export function formatModelRight(meta: FooterRightMeta, theme: StatusTheme): string {
  const pieces: string[] = [];
  if (meta.showProvider && meta.provider) {
    pieces.push(theme.fg('muted', `(${meta.provider})`));
  }
  pieces.push(theme.bold(theme.fg('accent', meta.modelId)));
  if (meta.thinkingLevel) {
    const color = THINKING_COLOR[meta.thinkingLevel] ?? 'muted';
    const label = meta.thinkingLevel === 'off' ? 'thinking off' : meta.thinkingLevel;
    pieces.push(theme.fg('dim', '•'));
    pieces.push(theme.fg(color, label));
  }
  return pieces.join(' ');
}

/** Plain-text summary appended to `/devin-status`. */
export function formatQuotaSummary(quota: DevinQuota, nowMs = Date.now()): string | undefined {
  const parts: string[] = [];
  if (quota.planName) parts.push(`plan=${quota.planName}`);
  if (!quota.hideDailyQuota && quota.dailyRemainingPercent !== undefined) {
    const reset = formatResetIn(quota.dailyResetAtUnix, nowMs);
    parts.push(`daily=${Math.round(quota.dailyRemainingPercent)}% left${reset ? ` (resets ${reset})` : ''}`);
  }
  if (!quota.hideWeeklyQuota && quota.weeklyRemainingPercent !== undefined) {
    const reset = formatResetIn(quota.weeklyResetAtUnix, nowMs);
    parts.push(`weekly=${Math.round(quota.weeklyRemainingPercent)}% left${reset ? ` (resets ${reset})` : ''}`);
  }
  if (quota.overageBalanceUsd !== undefined && quota.overageBalanceUsd > 0) {
    parts.push(`overage=$${quota.overageBalanceUsd.toFixed(2)}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}
