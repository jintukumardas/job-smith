/** Provider registry. Order here is the default display/priority order. */
import type { JobProvider } from "../provider.js";
import { remotiveProvider } from "./remotive.js";
import { remoteOkProvider } from "./remoteok.js";
import { wwrProvider } from "./wwr.js";
import { arbeitnowProvider } from "./arbeitnow.js";
import { hnProvider } from "./hn.js";

export const PROVIDERS: JobProvider[] = [
  remotiveProvider,
  remoteOkProvider,
  wwrProvider,
  arbeitnowProvider,
  hnProvider,
];

export const PROVIDER_MAP: Record<string, JobProvider> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
);

export function getProvider(id: string): JobProvider | undefined {
  return PROVIDER_MAP[id];
}
