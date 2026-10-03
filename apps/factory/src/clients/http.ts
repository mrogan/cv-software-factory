/**
 * What the telemetry backends have in common: a GET that returns JSON, and the shape of a metric answer.
 *
 * An error names the backend and the status and never the response, because a response can hold what the backend
 * was asked for, and what the log watcher asks Loki for includes visitors' reports.
 */
export type Fetch = typeof fetch;

export async function getJson(
  fetcher: Fetch,
  base: string,
  path: string,
  params: Record<string, string | number> = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  const url = new URL(path, base);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${url.host}${path} answered ${response.status}`);
  return response.json();
}

/** One series of an instant query: its labels and its value. */
export interface Sample {
  labels: Record<string, string>;
  value: number;
}

/** A number as Prometheus and Loki write it, or null for the NaN of a ratio with nothing to divide. */
export function toNumber(text: unknown): number | null {
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The series of an instant query's answer, with NaN and infinity left out. */
export function samplesOf(answer: unknown): Sample[] {
  const result = (answer as { data?: { result?: unknown } })?.data?.result;
  if (!Array.isArray(result)) throw new Error('A backend answered an instant query with something else');
  return result.flatMap((series: { metric?: Record<string, string>; value?: [number, string] }) => {
    const value = toNumber(series.value?.[1]);
    return value === null ? [] : [{ labels: series.metric ?? {}, value }];
  });
}
