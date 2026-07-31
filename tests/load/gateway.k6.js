import { check, sleep } from 'k6';
import http from 'k6/http';
import { Rate, Trend } from 'k6/metrics';

/**
 * Gateway load profile.
 *
 * Run against a deployed stack:
 *
 *   k6 run -e BASE_URL=https://api.example.com tests/load/gateway.k6.js
 *
 * Not runnable in CI without infrastructure, and deliberately not faked into
 * something that is — a load test against a mock measures the mock.
 *
 * The shape matters more than the peak. Traffic here is not uniform: the lobby
 * is polled continuously by everyone sitting in the menu, while writes arrive
 * in a burst every ten minutes when a match cycle turns over. A flat arrival
 * rate would report a healthy p95 and tell you nothing about the only moment
 * that has ever been a problem.
 */

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';

const errorRate = new Rate('business_errors');
const rateLimited = new Rate('rate_limited');
const leaderboardLatency = new Trend('leaderboard_latency', true);

export const options = {
  scenarios: {
    /** The steady background: browsers idling on the lobby screen. */
    lobby_polling: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 200 },
        { duration: '2m', target: 200 },
        { duration: '30s', target: 0 },
      ],
      exec: 'pollLobby',
    },

    /**
     * The ten-minute cycle turnover, where every queued player acts at once.
     * `constant-arrival-rate` rather than VUs because the interesting question
     * is whether the service holds a fixed *arrival* rate — if it slows down,
     * VU-based load politely slows with it and hides the problem.
     */
    cycle_burst: {
      executor: 'constant-arrival-rate',
      rate: 400,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 200,
      maxVUs: 800,
      startTime: '45s',
      exec: 'readHeavy',
    },
  },

  thresholds: {
    // p95 rather than mean: the mean hides the tail, and the tail is what a
    // player actually experiences as "the site is slow".
    'http_req_duration{expected_response:true}': ['p(95)<400', 'p(99)<1500'],
    leaderboard_latency: ['p(95)<300'],
    business_errors: ['rate<0.01'],
    // Some rate limiting under a burst is the system working. A lot of it means
    // the limits are set below real demand.
    rate_limited: ['rate<0.05'],
  },
};

/** Counts a response, distinguishing "throttled" from "broken". */
function record(response) {
  const limited = response.status === 429;
  rateLimited.add(limited);
  // A 429 is the platform defending itself, not an error. Counting it as one
  // would make a correctly-configured limiter look like an outage.
  errorRate.add(!limited && response.status >= 400);
  return !limited && response.status < 400;
}

export function pollLobby() {
  const responses = http.batch([
    ['GET', `${BASE_URL}/v1/rooms`, null, { tags: { name: 'rooms' } }],
    ['GET', `${BASE_URL}/v1/leaderboard?window=daily`, null, { tags: { name: 'leaderboard' } }],
  ]);

  for (const response of responses) record(response);

  const leaderboard = responses[1];
  leaderboardLatency.add(leaderboard.timings.duration);

  check(leaderboard, {
    'leaderboard returns entries array': (r) => {
      if (r.status !== 200) return false;
      try {
        return Array.isArray(r.json('entries'));
      } catch {
        return false;
      }
    },
    // The contract that stops a client corrupting balances above 2^53.
    'lamports are strings': (r) => {
      if (r.status !== 200) return true;
      try {
        const first = r.json('entries.0.score');
        return first === undefined || typeof first === 'string';
      } catch {
        return false;
      }
    },
  });

  // Real clients poll every couple of seconds; hammering harder measures a load
  // pattern nobody generates.
  sleep(2 + Math.random());
}

export function readHeavy() {
  const responses = http.batch([
    ['GET', `${BASE_URL}/v1/rooms`, null, { tags: { name: 'rooms' } }],
    ['GET', `${BASE_URL}/v1/games?limit=20`, null, { tags: { name: 'games' } }],
    ['GET', `${BASE_URL}/health/ready`, null, { tags: { name: 'health' } }],
  ]);

  for (const response of responses) record(response);

  // Readiness must survive the burst. A rate-limited or slow probe restarts the
  // pod, turning a traffic spike into an outage — which is why it is
  // allow-listed in the limiter, and this is the check that proves it.
  check(responses[2], { 'readiness stays green under load': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(
      {
        p95_ms: data.metrics.http_req_duration?.values?.['p(95)'],
        p99_ms: data.metrics.http_req_duration?.values?.['p(99)'],
        requests: data.metrics.http_reqs?.values?.count,
        error_rate: data.metrics.business_errors?.values?.rate,
        rate_limited: data.metrics.rate_limited?.values?.rate,
      },
      null,
      2,
    ),
  };
}
