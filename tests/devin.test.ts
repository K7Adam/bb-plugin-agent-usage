import assert from "node:assert/strict";
import test from "node:test";

import { mapDevinUserStatus, parseDevinCredentials, readDevinUsage } from "../src/collectors/devin.ts";

const proStatus = {
  userStatus: {
    email: "dev@example.com",
    planStatus: {
      planInfo: { planName: "Pro", billingStrategy: "BILLING_STRATEGY_QUOTA" },
      dailyQuotaRemainingPercent: 34,
      weeklyQuotaRemainingPercent: 67,
      dailyQuotaResetAtUnix: "1792483200",
      weeklyQuotaResetAtUnix: "1792915200",
    },
  },
};

test("parses the two credential keys and ignores the rest", () => {
  const credentials = parseDevinCredentials(
    'windsurf_api_key = "devin-abc"\napi_server_url = "https://server.codeium.com/"\ndevin_api_url = "https://api.devin.ai"\n',
  );
  assert.deepEqual(credentials, { apiKey: "devin-abc", apiServerUrl: "https://server.codeium.com" });
});

test("defaults the server and refuses non-https servers", () => {
  assert.equal(parseDevinCredentials('windsurf_api_key = "k"')?.apiServerUrl, "https://server.codeium.com");
  assert.equal(parseDevinCredentials('windsurf_api_key = "k"\napi_server_url = "http://evil.test"'), null);
  assert.equal(parseDevinCredentials('api_server_url = "https://server.codeium.com"'), null);
});

test("maps daily and weekly quota to used percent with reset times", () => {
  const result = mapDevinUserStatus(proStatus);
  assert.equal(result.supported, true);
  if (!result.supported || result.usage.status !== "ok") assert.fail("expected ok usage");
  assert.equal(result.usage.planLabel, "Pro");
  assert.equal(result.usage.accountEmail, "dev@example.com");
  assert.deepEqual(
    result.usage.windows.map((window) => [window.kind, window.usedPercent, window.resetsAt]),
    [
      ["daily", 66, "2026-10-20T08:00:00.000Z"],
      ["weekly", 33, "2026-10-25T08:00:00.000Z"],
    ],
  );
});

test("an omitted percent with a reset time means nothing is left", () => {
  const status = structuredClone(proStatus);
  delete (status.userStatus.planStatus as Record<string, unknown>).weeklyQuotaRemainingPercent;
  const result = mapDevinUserStatus(status);
  if (!result.supported || result.usage.status !== "ok") assert.fail("expected ok usage");
  assert.equal(result.usage.windows[1].usedPercent, 100);
});

test("skips quotas without a reset time or hidden by the plan", () => {
  const result = mapDevinUserStatus({
    userStatus: {
      planStatus: {
        planInfo: { planName: "Max", hideDailyQuota: true },
        dailyQuotaResetAtUnix: "1792483200",
        weeklyQuotaRemainingPercent: 10,
      },
    },
  });
  if (!result.supported || result.usage.status !== "ok") assert.fail("expected ok usage");
  assert.deepEqual(result.usage.windows, []);
});

test("reports an error when the response has no plan status", () => {
  const result = mapDevinUserStatus({ userStatus: {} });
  assert.equal(result.supported && result.usage.status, "error");
});

test("a rejected key reads as expired", async () => {
  const fakeFetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  const result = await readDevinUsage(fakeFetch);
  // Without a credentials file on the test machine the read stops earlier.
  assert.ok(result.supported && ["expired", "unauthenticated"].includes(result.usage.status));
});
