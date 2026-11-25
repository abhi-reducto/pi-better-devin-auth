import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { clearCachedQuota, getCachedQuota, parseUserStatusResponse } from '../src/cloud-direct/quota.js';
import {
  formatModelRight,
  formatQuotaFooter,
  formatQuotaSegment,
  formatQuotaSummary,
  formatResetIn,
  formatStatsLeft,
  quotaBar,
  quotaTone,
} from '../src/quota-format.js';

const plainTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};

const samplePayload = {
  userStatus: {
    teamsTier: 'TEAMS_TIER_DEVIN_MAX',
    planStatus: {
      planInfo: {
        planName: 'Max',
        teamsTier: 'TEAMS_TIER_DEVIN_MAX',
        billingStrategy: 'BILLING_STRATEGY_QUOTA',
        hideDailyQuota: true,
      },
      dailyQuotaRemainingPercent: 100,
      weeklyQuotaRemainingPercent: 97,
      overageBalanceMicros: '5010000000',
      dailyQuotaResetAtUnix: '1795680000',
      weeklyQuotaResetAtUnix: '1795939200',
    },
  },
};

describe('parseUserStatusResponse', () => {
  it('extracts plan, weekly/daily quota, reset times, and overage USD', () => {
    const q = parseUserStatusResponse(samplePayload, 1000);
    assert.equal(q.planName, 'Max');
    assert.equal(q.teamsTier, 'TEAMS_TIER_DEVIN_MAX');
    assert.equal(q.dailyRemainingPercent, 100);
    assert.equal(q.weeklyRemainingPercent, 97);
    assert.equal(q.hideDailyQuota, true);
    assert.equal(q.overageBalanceUsd, 5010);
    assert.equal(q.weeklyResetAtUnix, 1795939200);
    assert.equal(q.fetchedAt, 1000);
  });
});

describe('getCachedQuota', () => {
  beforeEach(() => clearCachedQuota());

  it('fetches GetUserStatus and caches per account', async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      calls++;
      assert.ok(String(input).endsWith('/exa.seat_management_pb.SeatManagementService/GetUserStatus'));
      const body = JSON.parse(String(init?.body)) as { metadata: { api_key: string } };
      assert.equal(body.metadata.api_key, 'test-key');
      return new Response(JSON.stringify(samplePayload), { status: 200 });
    };

    const first = await getCachedQuota('test-key', 'https://example.test', undefined, fakeFetch);
    const second = await getCachedQuota('test-key', 'https://example.test', undefined, fakeFetch);
    assert.equal(calls, 1);
    assert.equal(first.weeklyRemainingPercent, 97);
    assert.equal(second.weeklyRemainingPercent, 97);
  });
});

describe('quota formatting', () => {
  it('picks green/yellow/red tones by remaining percentage', () => {
    assert.equal(quotaTone(97), 'success');
    assert.equal(quotaTone(20), 'warning');
    assert.equal(quotaTone(5), 'error');
  });

  it('renders a 6-cell progress bar', () => {
    assert.equal(quotaBar(100), '██████');
    assert.equal(quotaBar(50), '███░░░');
    assert.equal(quotaBar(0), '░░░░░░');
  });

  it('formats reset durations compactly', () => {
    const now = 1_795_600_000_000;
    assert.equal(formatResetIn(1_795_600_000 + 3 * 86_400 + 4 * 3600, now), '3d 4h');
    assert.equal(formatResetIn(1_795_600_000 + 5 * 3600 + 12 * 60, now), '5h 12m');
    assert.equal(formatResetIn(1_795_600_000 + 9 * 60, now), '9m');
  });

  it('formats a colored quota segment respecting hideDailyQuota', () => {
    const q = parseUserStatusResponse(samplePayload, 1000);
    const now = (1795939200 - (3 * 86_400 + 12 * 3600)) * 1000;
    const line = formatQuotaFooter(q, plainTheme, now);
    assert.equal(
      line,
      '<b><accent>Devin Max</accent></b><dim> · </dim><muted>wk </muted><success>██████ 97%</success><dim> (3d 12h)</dim><dim> · </dim><syntaxString>+$5010.00</syntaxString>',
    );
  });

  it('supports compact quota mode for narrow terminals', () => {
    const q = parseUserStatusResponse(samplePayload, 1000);
    const now = (1795939200 - 3 * 86_400) * 1000;
    const line = formatQuotaSegment(q, plainTheme, now, true);
    assert.equal(
      line,
      '<muted>wk </muted><success>█████ 97%</success><dim> (3d)</dim><dim> · </dim><syntaxString>+$5010.00</syntaxString>',
    );
  });

  it('colors each token stat, cache hit, cost, context, and inline quota on one line', () => {
    const q = parseUserStatusResponse(samplePayload, 1000);
    const now = (1795939200 - (3 * 86_400 + 12 * 3600)) * 1000;
    const left = formatStatsLeft(
      {
        input: 708_000,
        output: 51_000,
        cacheRead: 7_300_000,
        cacheWrite: 0,
        cost: 3.111,
        latestCacheHitRate: 98.8,
        contextPercent: 16.5,
        contextWindow: 1_000_000,
        usingSubscription: true,
      },
      q,
      plainTheme,
      now,
    );
    assert.equal(
      left,
      '<syntaxFunction>↑708k</syntaxFunction> <syntaxKeyword>↓51k</syntaxKeyword> <accent>R7.3M</accent> <success>CH98.8%</success> <syntaxNumber>$3.111</syntaxNumber><dim> (sub)</dim> <success>16.5%/1.0M</success> <dim>│</dim> <b><accent>Devin Max</accent></b><dim> · </dim><muted>wk </muted><success>██████ 97%</success><dim> (3d 12h)</dim><dim> · </dim><syntaxString>+$5010.00</syntaxString>',
    );
  });

  it('colors model and thinking level on the right', () => {
    const right = formatModelRight(
      { provider: 'devin', modelId: 'gemini-4-neon', thinkingLevel: 'medium', showProvider: true },
      plainTheme,
    );
    assert.equal(
      right,
      '<muted>(devin)</muted> <b><accent>gemini-4-neon</accent></b> <dim>•</dim> <thinkingMedium>medium</thinkingMedium>',
    );
  });

  it('formats plain summary for /devin-status', () => {
    const q = parseUserStatusResponse(samplePayload, 1000);
    const now = (1795939200 - 3600) * 1000;
    assert.equal(
      formatQuotaSummary(q, now),
      'plan=Max, weekly=97% left (resets 1h), overage=$5010.00',
    );
  });
});
