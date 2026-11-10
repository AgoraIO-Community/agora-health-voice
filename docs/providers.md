# Health data providers

`HEALTH_DATA_PROVIDER=synthetic` is the default and serves the existing fictional
fixtures. `HEALTH_DATA_PROVIDER=custom` creates the Garmin Personal API adapter.
Provider failures never fall back to fictional values. The browser, Agora voice
configuration, callback authentication, and four tool schemas are shared unchanged.

## Garmin setup (server only)

- Keep the existing key in `~/.config/garmin/connect-personal-api-key`. The adapter
  requires a regular file owned by the running user, without group/world access
  (normally mode `0600` or `0400`), and refuses symlinks. It never modifies the file.
- An explicitly set `GARMIN_PERSONAL_API_KEY` overrides the file. Leave it **unset**
  to use the file; an empty variable is a configuration error. Do not put keys in
  browser code, command-line arguments, source files, logs, or committed files.
- Select `HEALTH_DATA_PROVIDER=custom` and `HEALTH_TIME_ZONE=Asia/Kolkata` in the
  ignored local `.env` when ready to use real data. The calendar default is also
  Asia/Kolkata. Keep `synthetic` selected until live testing is authorized.
- No Garmin username/password, refresh token, OAuth client secret, database,
  Supabase session, or Arova owner UUID is required for this single-owner adapter.

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

## Mapping and missing data

| Contract | Garmin read and normalized result |
|---|---|
| `movement(date)` | `/usersummary-service/v2/dailysummaries` for one exact date; `movement.steps.value` and `distanceInMeters` |
| `sleep(date)` | `/sleep-service/sleep/dailySleep`; `sleepTimeSeconds` in seconds |
| `heartRate(date)` | `/wellness-service/wellness/dailyHeartRate`; `restingHeartRate`, `minHeartRate`, `maxHeartRate` in bpm |
| `recentActivities(limit)` | `/activitylist-service/activities/search/activities`; generic type, `duration` in seconds and `distance` in metres |

Dates stay exact `YYYY-MM-DD` values. “Last night” resolves to the current local
date, matching Garmin's overnight summary date; “yesterday” uses the previous
calendar date. Garmin activity `startTimeLocal` supplies the recorded local date
without a UTC shift. Activity pages are sorted newest first, with duplicate IDs
and inconsistent page ordering rejected. At most three two-record pages are read
for the existing maximum of five activities; an unavailable later page fails the
operation rather than returning an incomplete answer.

Partial valid measurements remain available independently; absent/null fields
become `missing`, and numeric zero remains available where valid (heart rates must
be positive). No daily measurements means a missing record. Null/204/404 and empty
daily responses mean missing data; malformed populated responses and mismatched
dates are errors. Empty activity lists remain empty and the existing tool layer
reports them as missing. No interpolation, sample-based inference, or synthetic
fallback is performed. Account identifiers, free-text activity titles, routes and
raw samples are excluded. Sleep stages/scores available upstream are deliberately
not exposed: the unchanged `Sleep` interface and sleep tool support duration only.

## Provider independence and validation

`HealthDataProvider` in `src/providers/types.ts` remains the minimum adapter
interface: `sleep(date)`, `heartRate(date)`, `movement(date)` and
`recentActivities(limit)`. Future providers implement this same contract with
source-specific credential exchange and mapping behind the factory. Normalize
seconds/metres/bpm, preserve missing versus unsupported, and throw on operational
failures. The synthetic implementation remains separate and unchanged.

`npm test` builds and runs the existing voice/fictional-provider tests plus mocked
Garmin tests. Garmin tests inject fake credentials, fetch responses and clocks;
they never read the real key or contact Garmin. They cover protected credential
files, token sharing/expiry/renewal, dates, partial and missing fields, pagination,
invalid responses, request deadlines and sanitized failures.

Live validation requires separate explicit authorization. Before that step,
confirm the account owner's authorization and Garmin's applicable Personal API
terms, including sending normalized measurements through the conversational stack
(Agora/model processing and Murf speech). The Personal API is for individual use;
commercial multi-user integrations require another Garmin integration route.

References: [Garmin Personal API FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)
and [Garmin reference client](https://github.com/garmin/connect-personal-api-python).
