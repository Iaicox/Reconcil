/**
 * ECB daily reference rates — the FX source (ADR-007). SDMX data API, series
 * `D.USD.EUR.SP00.A` (USD per 1 EUR). Fetched over a range because ECB has no
 * weekend/holiday rows; the read side (fx.ts) picks the latest ≤ target date.
 * Observations map to dates via the TIME_PERIOD dimension in `structure`.
 */
import { numberToDecimalString } from '../decimal.js';
import type { FetchJson, FxProvider, FxRatePoint } from './types.js';

interface SdmxBody {
  dataSets?: Array<{ series?: Record<string, { observations?: Record<string, unknown[]> }> }>;
  structure?: { dimensions?: { observation?: Array<{ id: string; values: Array<{ id: string }> }> } };
}

export function parseEcbRange(body: unknown): FxRatePoint[] {
  const b = body as SdmxBody;
  const series = b.dataSets?.[0]?.series;
  if (!series) return [];
  const firstSeries = Object.values(series)[0];
  const observations = firstSeries?.observations;
  if (!observations) return [];
  const periods = b.structure?.dimensions?.observation?.find((d) => d.id === 'TIME_PERIOD')?.values ?? [];

  const out: FxRatePoint[] = [];
  for (const [idx, arr] of Object.entries(observations)) {
    const date = periods[Number(idx)]?.id;
    const rate = numberToDecimalString(arr[0]);
    if (date !== undefined && rate !== null) out.push({ date, quote: 'USD', rate });
  }
  return out;
}

export function ecbProvider(fetchJson: FetchJson): FxProvider {
  return {
    source: 'ecb',
    async rangeRates(from, to) {
      const url = `https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=${from}&endPeriod=${to}&format=jsondata`;
      const { status, body } = await fetchJson(url);
      if (status !== 200) return [];
      return parseEcbRange(body);
    },
  };
}
