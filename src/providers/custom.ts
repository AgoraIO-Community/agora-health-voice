import type { HealthDataProvider } from "./types.js";

export function createCustomProvider(): HealthDataProvider {
  throw new Error("The custom health data provider is unimplemented. See docs/providers.md.");
}
