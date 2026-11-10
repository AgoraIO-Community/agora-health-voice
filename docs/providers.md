# Health data providers

`HEALTH_DATA_PROVIDER=synthetic` is the default. It serves local fictional records. `HEALTH_DATA_PROVIDER=custom` exits at startup until you implement `createCustomProvider` in `src/providers/custom.ts`. That factory is the single extension point. The browser, Agora configuration, and tool schemas use the same contract for either mode.

## Custom adapter template

1. Read the authorized source's credentials from server environment variables and validate them when creating the adapter. Use bounded, server-side HTTPS requests and keep tokens and raw responses out of logs.
2. Return a `HealthDataProvider` with `sleep(date)`, `heartRate(date)`, `movement(date)`, and `recentActivities(limit)`. Each daily lookup receives an exact `YYYY-MM-DD` date. Configure `HEALTH_TIME_ZONE` for the source's calendar. For overnight sleep, the tool asks for the current local date when it hears “last night.” Map this convention to the source's date model and preserve the normalized record date. Return missing when no matching record exists.
3. Normalize durations to seconds, distances to metres, and heart rates to bpm. Map absent data to `missing`, fields the source cannot supply to `unsupported`, and numeric zero to an available value. Throw on timeouts, authorization failures, or invalid upstream responses. The tool reports those as `unavailable`.
4. Return recent activities newest first and honor the requested limit. Use generic activity types such as “Run” or “Walk.” Exclude account IDs, route traces, free-text activity titles, raw samples, and other fields outside the contract.
5. Before enabling a source with real data, verify the account owner's authorization and the source's terms for sharing values with the conversational stack. The callback returns normalized measurements to Agora for model processing. The resulting spoken answer goes to Murf for synthesis.

## Garmin Personal API mapping example

For a personal, self-hosted extension, create a key in Garmin Connect Web and keep it in a server-only variable such as `GARMIN_PERSONAL_API_KEY`. Exchange the key with `Authorization: ApiKey …` at Garmin's token endpoint and use the returned bearer for authorized reads. Cache the bearer in memory until near expiry. Obtain a new bearer by exchanging the key again. [Garmin Personal API setup and authentication](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)

| Contract method | Documented Personal API mapping |
|---|---|
| `sleep(date)` | Daily sleep. Use the recorded calendar date and measured sleep seconds. |
| `heartRate(date)` | Daily heart rate. Select resting, minimum, and maximum values when present. |
| `movement(date)` | Daily steps for a one-day range. Map the step count and step distance in metres. |
| `recentActivities(limit)` | Activity search summaries. Select only local date, type, duration, and distance. |

See [Garmin's reference endpoint list](https://github.com/garmin/connect-personal-api-python#supported-endpoints) for current paths and [Personal API Swagger documentation](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/) for response schemas. Review the terms accepted at key creation before using real data. For other authorized sources, follow the same mapping, keeping source-specific credential exchange and field conversion within the custom adapter.
