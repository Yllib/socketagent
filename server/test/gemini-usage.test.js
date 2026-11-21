const assert = require("node:assert/strict");
const test = require("node:test");

const { parseGeminiQuotaUsage, selectGeminiUsageForModel } = require("#server/gemini-usage");

const FIXTURE = {
  email: "user@example.com",
  fetchedAt: "2026-11-21T05:21:29Z",
  loadCodeAssist: {
    cloudaicompanionProject: "proj-1",
    currentTier: { name: "Antigravity" },
    paidTier: { name: "Google AI Pro" },
  },
  summary: {
    groups: [
      {
        displayName: "Claude and GPT models",
        buckets: [
          {
            bucketId: "3p-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            resetTime: "2026-11-28T05:21:29Z",
            remainingFraction: 0.75,
          },
          {
            bucketId: "3p-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            resetTime: "2026-11-21T10:21:29Z",
            remainingFraction: 0.9,
          },
        ],
      },
    ],
  },
  quota: {
    buckets: [
      {
        modelId: "gemini-4-hydrogen-sonar",
        tokenType: "WTUS",
        remainingFraction: 0.5239,
        resetTime: "2026-11-21T07:26:47Z",
      },
      {
        modelId: "gemini-2.5-pro",
        tokenType: "WTUS",
        remainingFraction: 0.5239,
        resetTime: "2026-11-21T07:26:47Z",
      },
      {
        modelId: "tab_flash_lite_preview",
        tokenType: "WTUS",
        remainingFraction: 1,
      },
    ],
  },
};

test("parseGeminiQuotaUsage scopes Gemini sessions to Gemini limits only and 3P models to Claude & GPT limits", () => {
  const full = parseGeminiQuotaUsage(FIXTURE);
  assert.equal(full.plan, "Google AI Pro");
  assert.equal(full.windows.length, 3);

  const geminiOnly = selectGeminiUsageForModel(full, "gemini-4-neon");
  assert.equal(geminiOnly.available, true);
  assert.equal(geminiOnly.windows.length, 1);
  assert.equal(geminiOnly.windows[0].label, "5-hour");
  assert.equal(geminiOnly.windows[0].usedPercent, 47.6);
  assert.equal(geminiOnly.windows[0].resetTime, "2026-11-21T07:26:47Z");

  // Unspecified model defaults to Gemini limits.
  const defaultScoped = selectGeminiUsageForModel(full);
  assert.equal(defaultScoped.windows.length, 1);
  assert.equal(defaultScoped.windows[0].label, "5-hour");

  // Selecting a Claude or GPT model via Antigravity shows only its 5h/Weekly limits.
  const thirdParty = selectGeminiUsageForModel(full, "claude-opus-5-5");
  assert.equal(thirdParty.available, true);
  assert.equal(thirdParty.windows.length, 2);
  assert.equal(thirdParty.windows[0].label, "Claude & GPT · 5-hour");
  assert.equal(thirdParty.windows[0].usedPercent, 10);
  assert.equal(thirdParty.windows[1].label, "Claude & GPT · Weekly");
  assert.equal(thirdParty.windows[1].usedPercent, 25);
});

test("parseGeminiQuotaUsage does not duplicate Gemini when summary already includes a Gemini group", () => {
  const usage = parseGeminiQuotaUsage({
    fetchedAt: "2026-11-21T05:21:29Z",
    model: "gemini-4-neon",
    summary: {
      groups: [
        {
          displayName: "Gemini models",
          buckets: [
            {
              bucketId: "gemini-5h",
              window: "5h",
              resetTime: "2026-11-21T09:00:00Z",
              remainingFraction: 0.4,
            },
            {
              bucketId: "gemini-weekly",
              window: "weekly",
              resetTime: "2026-11-28T05:00:00Z",
              remainingFraction: 0.8,
            },
          ],
        },
      ],
    },
    quota: {
      buckets: [
        {
          modelId: "gemini-2.5-pro",
          remainingFraction: 0.4,
          resetTime: "2026-11-21T09:00:00Z",
        },
      ],
    },
  });

  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].label, "5-hour");
  assert.equal(usage.windows[0].usedPercent, 60);
  assert.equal(usage.windows[1].label, "Weekly");
  assert.equal(usage.windows[1].usedPercent, 20);
});

test("parseGeminiQuotaUsage splits distinct Gemini Pro and Flash quota pools", () => {
  const usage = parseGeminiQuotaUsage({
    fetchedAt: "2026-11-21T05:00:00Z",
    model: "gemini-2.5-pro",
    quota: {
      buckets: [
        { modelId: "gemini-2.5-pro", remainingFraction: 0.2, resetTime: "2026-11-21T08:00:00Z" },
        { modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: "2026-11-21T09:00:00Z" },
      ],
    },
  });

  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].label, "Pro · 5-hour");
  assert.equal(usage.windows[0].usedPercent, 80);
  assert.equal(usage.windows[1].label, "Flash · 5-hour");
  assert.equal(usage.windows[1].usedPercent, 10);
});
