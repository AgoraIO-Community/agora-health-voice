# Health data providers

The recipe depends on a small health-data interface, not a particular health
account. The browser, Agora configuration, callback authentication and four tool
schemas stay the same when the source changes. Source-specific credentials,
requests and field mapping belong inside a server-side adapter.

## Select an included provider

| `HEALTH_DATA_PROVIDER` | Current implementation | Credentials |
|---|---|---|
| `synthetic` (default) | Fictional JSON fixtures, anchored to 2025-02-14 | No health account or Garmin key |
| `custom` | Included Garmin Personal API adapter | Owner's server-side Garmin key |

`custom` is the existing selector for Garmin, not a dynamic plugin loader. The
current factory is the provider-selection branch in [src/server.ts](../src/server.ts).
Unknown selectors fail at startup. A future adapter needs an explicit factory
change; setting an arbitrary module path or provider name is not supported.
No factory or runtime changes are part of this documentation update.

## Generic adapter contract

The authoritative types are in [src/providers/types.ts](../src/providers/types.ts):

```ts
interface HealthDataProvider {
  sleep(date: CalendarDate): Promise<ReadResult<Sleep>>;
  heartRate(date: CalendarDate): Promise<ReadResult<HeartRate>>;
  movement(date: CalendarDate): Promise<ReadResult<Movement>>;
  recentActivities(limit: number): Promise<ReadResult<readonly Activity[]>>;
}
```

| Record | Normalized fields |
|---|---|
| `Sleep` | `date`, `sleepSeconds` |
| `HeartRate` | `date`, `restingBpm`, `minBpm`, `maxBpm` |
| `Movement` | `date`, `steps`, `distanceMetres` |
| `Activity` | `date`, generic `type`, `durationSeconds`, `distanceMetres` |

Each numeric field is a `Measurement`: `{ status: "available", value: number }`,
`{ status: "missing" }` or `{ status: "unsupported" }`. Each method returns
`{ status: "available", record: ... }`, `{ status: "missing" }` or
`{ status: "unsupported" }`. Preserve partial records: one missing field does not
make available sibling measurements disappear.

Adapter rules:

- Accept exact calendar dates (`YYYY-MM-DD`) and return the requested date for
  daily records. Runtime validation is necessary: the TypeScript date type alone
  does not prove a date exists. The shared tool layer resolves `today`,
  `yesterday` and sleep-only `lastNight` before calling the adapter. Synthetic
  mode uses its fixed demo date; live mode uses `HEALTH_TIME_ZONE`, defaulting to
  `Asia/Kolkata`. Define the source's overnight-sleep date convention explicitly.
- Normalize duration to seconds, distance to metres and heart rate to bpm. Keep
  daily movement distance distinct from activity distance. Validate numbers and
  preserve legitimate zero; do not turn absent values into zero.
- Use `missing` for a supported measurement absent on the requested date and
  `unsupported` for a capability the source cannot provide. Throw a sanitized
  error for authentication, transport or malformed-response failures; the callback
  layer maps it to `unavailable`. Never fall back to fictional measurements after
  a live provider failure.
- Return recent activities newest first, bounded by the requested limit (1–5 at
  the tool boundary). An available empty array becomes `missing` in the tool
  response. Keep account identifiers, routes and unnecessary free text out of the
  normalized contract.
- Keep credential exchange and tokens on the server. Bound requests, response
  sizes and retries, and design for the existing five-second callback timeout.
  Do not log tokens, upstream bodies or personal measurements.

For example, a source with sleep duration in minutes can map a validated record
as follows. This is an illustrative adapter fragment, not a registered provider:

```ts
import type { HealthDataProvider } from "./types.js";

const sleep: HealthDataProvider["sleep"] = async date => {
  // Replace this fictional row with a bounded, authenticated server-side read.
  const row = { date, durationMinutes: 420 };
  return {
    status: "available",
    record: {
      date: row.date,
      sleepSeconds: { status: "available", value: row.durationMinutes * 60 },
    },
  };
};
```

To add a provider later, implement all four methods (returning `unsupported` where
appropriate), register it explicitly in the server factory, and add mocked
contract tests for dates, units, missing/unsupported values, zero, failures and
activity ordering. No browser, callback-schema or model-prompt changes should be
needed for an adapter that satisfies this contract. This extensibility concerns
health data; ASR, model and TTS vendors remain fixed by the current Agora gateway.

## First live reference: Garmin Personal API

### Setup (server only)

- Keep the existing key in `~/.config/garmin/connect-personal-api-key`. The adapter
  requires a regular file owned by the running user, without group/world access
  (normally mode `0600` or `0400`), and refuses symlinks. It never modifies the file.
- An explicitly set `GARMIN_PERSONAL_API_KEY` overrides the file. Leave it **unset**
  to use the file; an empty variable is a configuration error. Do not put keys in
  browser code, command-line arguments, source files, logs, or committed files.
- Select `HEALTH_DATA_PROVIDER=custom` and `HEALTH_TIME_ZONE=Asia/Kolkata` in the
  ignored local `.env` when ready to use real data. The calendar default is also
  Asia/Kolkata. Keep `synthetic` selected until live testing is authorized.
- No Garmin username/password, refresh token, OAuth client secret, or
  application database session is required for this single-owner adapter.

Construction loads and validates the credential locally but makes no network
requests. The first provider operation exchanges it at the fixed Garmin Personal
API token endpoint using `Authorization: ApiKey ...`. Tokens stay in memory,
shared across concurrent operations. Renewal occurs one minute before JWT expiry,
with a maximum cached lifetime of 24 hours. One data-request 401 permits one token
renewal and retry; other HTTP failures are not automatically retried. Restart the
process after replacing a key. Key validity cannot be established offline.

Each Garmin operation has a fourteen-second total deadline, including token waiting,
response bodies and activity pages. Token issuance has a ten-second deadline; each
data request retains a four-second deadline. The Agora tool timeout remains five
seconds, so cold authentication can exceed the callback window even though a direct
provider call succeeds. Data responses are limited to 512 KiB and token
responses to 16 KiB; redirects are rejected. Rate limits, invalid credentials,
timeouts and malformed responses throw sanitized errors, which the callback maps
to `unavailable`. No upstream bodies, tokens or measurement values are logged.

### Garmin mapping and missing data

| Contract | Garmin read and normalized result |
|---|---|
| `movement(date)` | `/usersummary-service/v2/dailysummaries` for one exact date; `movement.steps.value` and `movement.steps.distanceInMeters` |
| `sleep(date)` | `/sleep-service/sleep/dailySleep`; `sleepTimeSeconds` in seconds |
| `heartRate(date)` | `/wellness-service/wellness/dailyHeartRate`; `restingHeartRate`, `minHeartRate`, `maxHeartRate` in bpm |
| `recentActivities(limit)` | `/activitylist-service/activities/search/activities`; generic type, `duration` in seconds and `distance` in metres |

Dates stay exact `YYYY-MM-DD` values. “Last night” resolves to the current local
date, matching Garmin's overnight summary date; “yesterday” uses the previous
calendar date. Garmin activity `startTimeLocal` supplies the recorded local date
without a UTC shift. Activity pages are sorted newest first, with duplicate IDs
and inconsistent page ordering rejected. At most three two-record pages are read
for the existing maximum of five activities. An operational failure on a later
page fails the operation. A null response (including HTTP 204/404) is treated as
the end of the list and returns any activities already collected.

Partial valid measurements remain available independently; absent/null fields
become `missing`, and numeric zero remains available where valid (heart rates must
be positive). No daily measurements means a missing record. Null/204/404 and empty
daily responses mean missing data; malformed populated responses and mismatched
dates are errors. Empty activity lists remain empty and the existing tool layer
reports them as missing. No interpolation, sample-based inference, or synthetic
fallback is performed. Account identifiers, free-text activity titles, routes and
raw samples are excluded. Sleep stages/scores available upstream are deliberately
not exposed: the unchanged `Sleep` interface and sleep tool support duration only.

## Validation and live-data scope

`npm test` builds and runs the fictional-provider/voice tests and mocked Garmin
tests. Garmin tests inject fake credentials, fetch responses and clocks; they
never read the real key or contact Garmin. Coverage includes protected credential
files, token sharing/expiry/renewal, dates, partial and missing fields, pagination,
invalid responses, request deadlines and sanitized failures. This describes test
coverage, not a new test-run result.

The owner confirmed a successful end-to-end spoken steps query using real Garmin
data through Agora Conversational AI, with the returned count independently
verified against Garmin Connect. The exact prompt, test date, measurement date,
count and session artifact are not recorded here and are not inferred. The live
test was not repeated during this documentation update. This result does not
verify other live tools or a synthetic voice session.
See the [README validation record](../README.md#validation-and-evidence) for the
complete evidence boundary.

Further live validation requires separate explicit authorization. Before that
step, confirm the account owner's authorization and Garmin's applicable Personal
API terms, including sending normalized measurements through the conversational
stack (Agora/model processing and Murf speech). The existing adapter is intended
for individual use; evaluate an appropriate Garmin integration route and terms
before building a commercial multi-user service.

References: [Garmin Personal API FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)
and [Garmin reference client](https://github.com/garmin/connect-personal-api-python).
