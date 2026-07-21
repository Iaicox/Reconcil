import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type FlowAgg, foldBalances, foldCounterparties, foldFlows, foldGas } from '../src/fold.js';
import { arbWorld } from './arbitraries.js';

const bal = (m: Map<string, Map<number, bigint>>, a: string, t: number): bigint =>
  m.get(a)?.get(t) ?? 0n;

const flow = (m: Map<number, FlowAgg>, t: number): { inflow: bigint; outflow: bigint } =>
  m.get(t) ?? { inflow: 0n, outflow: 0n };

describe('property: prefix non-negativity (inv 4)', () => {
  it('every owned wallet balance is ≥ 0 at every prefix of a generated history', () => {
    fc.assert(
      fc.property(arbWorld, ({ events, owned, tokens }) => {
        for (let i = 1; i <= events.length; i++) {
          const b = foldBalances(events.slice(0, i), owned);
          for (const a of owned) {
            for (const tok of tokens) {
              expect(bal(b, a, tok.tokenId) >= 0n).toBe(true);
            }
          }
        }
      }),
    );
  });
});

describe('property: conservation (inv 1)', () => {
  it('balance(t2) − balance(t1) == inflow − outflow − gas per (wallet, token)', () => {
    fc.assert(
      fc.property(arbWorld, fc.nat(), ({ events, owned, tokens }, kSeed) => {
        if (events.length === 0) return;
        const k = kSeed % (events.length + 1); // split point in [0, len]
        const asOf = k === 0 ? new Date(0) : events[k - 1]!.blockTime;
        const fromBound = k < events.length ? events[k]!.blockTime : new Date(8.64e15);

        for (const a of owned) {
          const scope = [a]; // singleton scope: no internal transfers, every counterparty external
          const balAll = foldBalances(events, scope);
          const balK = foldBalances(events, scope, asOf);
          const flows = foldFlows(events, scope, { from: fromBound });
          const gas = foldGas(events, scope, { from: fromBound });

          for (const tok of tokens) {
            const delta = bal(balAll, a, tok.tokenId) - bal(balK, a, tok.tokenId);
            const f = flows.externalByToken.get(tok.tokenId);
            const inflow = f?.inflow ?? 0n;
            const outflow = f?.outflow ?? 0n;
            const gasAmount = gas.get(tok.tokenId)?.amount ?? 0n;
            expect(delta).toBe(inflow - outflow - gasAmount);
          }
        }
      }),
    );
  });
});

describe('property: additivity (inv 2)', () => {
  it('flows([a,c)) == flows([a,b)) ⊕ flows([b,c)) for any split b', () => {
    fc.assert(
      fc.property(arbWorld, fc.nat(), ({ events, owned, tokens }, kSeed) => {
        if (events.length === 0) return;
        const k = kSeed % (events.length + 1);
        const leftTo = k === 0 ? new Date(0) : events[k - 1]!.blockTime;
        const rightFrom = k < events.length ? events[k]!.blockTime : new Date(8.64e15);

        const whole = foldFlows(events, owned);
        const left = foldFlows(events, owned, { to: leftTo });
        const right = foldFlows(events, owned, { from: rightFrom });

        for (const tok of tokens) {
          for (const bucket of ['externalByToken', 'internalByToken'] as const) {
            const w = flow(whole[bucket], tok.tokenId);
            const l = flow(left[bucket], tok.tokenId);
            const r = flow(right[bucket], tok.tokenId);
            expect(w.inflow).toBe(l.inflow + r.inflow);
            expect(w.outflow).toBe(l.outflow + r.outflow);
          }
        }
      }),
    );
  });
});

describe('property: partition (inv 3)', () => {
  it('Σ per-token external flows == the token-agnostic total (no event lost or doubled)', () => {
    fc.assert(
      fc.property(arbWorld, ({ events, owned }) => {
        const S = new Set(owned);
        // Independent token-agnostic totals (a different code path than the fold).
        let totalIn = 0n;
        let totalOut = 0n;
        for (const ev of events) {
          if (ev.eventKind !== 'native_transfer' && ev.eventKind !== 'erc20_transfer') continue;
          const fromIn = S.has(ev.fromAddr);
          const toIn = S.has(ev.toAddr);
          if (fromIn && toIn) continue; // internal, not external
          if (toIn) totalIn += ev.amountRaw;
          else if (fromIn) totalOut += ev.amountRaw;
        }

        const { externalByToken } = foldFlows(events, owned);
        let sumIn = 0n;
        let sumOut = 0n;
        for (const a of externalByToken.values()) {
          sumIn += a.inflow;
          sumOut += a.outflow;
        }
        expect(sumIn).toBe(totalIn);
        expect(sumOut).toBe(totalOut);
      }),
    );
  });

  it('Σ per-counterparty external flows == per-token external total (inv 3)', () => {
    fc.assert(
      fc.property(arbWorld, ({ events, owned, tokens }) => {
        const cps = foldCounterparties(events, owned);
        const { externalByToken } = foldFlows(events, owned);
        for (const tok of tokens) {
          let inflow = 0n;
          let outflow = 0n;
          for (const perToken of cps.values()) {
            const a = perToken.get(tok.tokenId);
            if (a) {
              inflow += a.inflow;
              outflow += a.outflow;
            }
          }
          const ext = externalByToken.get(tok.tokenId);
          expect(inflow).toBe(ext?.inflow ?? 0n);
          expect(outflow).toBe(ext?.outflow ?? 0n);
        }
      }),
    );
  });
});
