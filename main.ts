// Rally Rider: a single-trade Donchian breakout bot for cbBTC (CBBTC/USDC).
//
// Strategy (chosen by backtest on the kit's 1,440-bar dev window, tuned on the
// first 960 bars and validated on the last 480, plus a 300-window block
// bootstrap and a time-reversed "crash" window):
//   - Entry: one buy only, when a bar's close breaks above the highest high of
//     the previous 60 bars (warm start: from bar 20 on, using however many
//     bars have been seen). Full size: 100% of cash. The dev window's whole
//     gain came from one fast rally (hours 3-4, +3.1%); every high-frequency
//     rule tested (EMA 8/21 cross, volatility breakout, RSI/Bollinger) bled
//     fees in the flat hours that followed and finished deep negative, while
//     this one-trade breakout kept +30.74 USDC on the full dev window.
//   - Exits, read again on every bar while holding: a hard stop 2.5% under
//     cost, a trailing stop 2.5% under the position's peak value, or a
//     Donchian exit (close under the lowest low of the last 30 bars). No
//     take-profit: the position rides to the end of the window unless a stop
//     fires. No re-entry after an exit or a filled buy.
//   - A global equity guard flattens and halts if equity ever falls 10%
//     under its start (unreachable with one position and the stops above, but
//     cheap insurance against a gap fill).
//
// Risk, from the backtests: worst single-trade loss is the 2.5% stop (~$25
// plus ~$2.60 of round-trip fees); dev-window max drawdown 2.0%; the
// block-bootstrap median net PnL is +$23.62 with P(PnL > 0) = 0.80 and a
// trade in ~100% of windows; on the mirrored crash window it loses $24.20
// on one stopped-out trade and still makes the 1-trade guardrail.
//
// Determinism: pure float64 arithmetic over the bars seen, no randomness, no
// wall clock, no environment, no files. A missing bar (a minute with no
// CBBTC bar) adds nothing to the history; a flat bar (o = h = l = c) can
// neither break out nor break down. Orders decided on the last batch are
// rejected by the harness (after_end) and the harness flattens whatever is
// held, so no special last-batch handling is needed beyond not wasting
// orders — a buy is only ever sent once, and a sell only while holding.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit's SDK shim: the
// harness sends hello once, then one batch per minute (each batch carries
// the bar that just closed, the fills of the orders decided on the previous
// batch, and the account), then done. Every batch is answered with exactly
// one reply echoing its seq. Orders decided on a batch fill at the next
// bar's open, so every decision here is made on the latest close.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Breakout lookback: the highest high of the previous N bars. */
const BREAKOUT_BARS = 60;
/** Donchian exit lookback: the lowest low of the previous M bars. */
const EXIT_BARS = 30;
/** First bar on which an entry may be considered (partial lookback before that). */
const WARM_BARS = 20;
/** Hard stop and trailing stop, in basis points under cost / peak value. */
const STOP_BPS = 250;
const TRAIL_BPS = 250;
/** Global equity guard: flatten and halt below this share of start equity. */
const EQUITY_GUARD_BPS = 9000;
/** Slippage cap on a buy, in bps vs the latest close: a buy rejected on a
    one-minute spike just waits for the next breakout bar. */
const MAX_SLIPPAGE_BPS = 100;
/** Slippage cap on a sell, in bps vs the latest close: deliberately wide.
    An exit is a stop — it must fill. With a tight cap a gap-down open
    rejects the sell and the retry fills lower still; a 5% cap only ever
    binds on a move that would have cost far more than the extra slippage.
    One-minute moves are ~8 bps typical, so in ordinary bars the cap never
    changes the fill price. */
const EXIT_SLIPPAGE_BPS = 500;

/** The bars seen so far, oldest first; a gap (a minute with no bar) adds nothing. */
const highs: number[] = [];
const lows: number[] = [];

/** True once a buy has filled; the entry is one-shot, never repeated. */
let entered = false;
/** True between sending a buy and hearing its fill or rejection. */
let buyPending = false;
/** True between sending a sell and hearing its fill or rejection. */
let sellPending = false;
/** True once the equity guard has fired; no further entries after that. */
let halted = false;
/** Peak value of the open position, in quote units (cash + position at close). */
let peakValue = 0n;

/** The highest high of the last `n` bars seen (excluding the current bar). */
function highestHigh(n: number): number | null {
  if (highs.length === 0) return null;
  let m = -Infinity;
  const from = highs.length > n ? highs.length - n : 0;
  for (let i = from; i < highs.length; i++) if (highs[i]! > m) m = highs[i]!;
  return m;
}

/** The lowest low of the last `n` bars seen (including the current bar, already pushed). */
function lowestLow(n: number): number | null {
  if (lows.length === 0) return null;
  let m = Infinity;
  const from = lows.length > n ? lows.length - n : 0;
  for (let i = from; i < lows.length; i++) if (lows[i]! < m) m = lows[i]!;
  return m;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Settle the orders decided on the previous batch from this batch's fills.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') {
        entered = true;
        buyPending = false;
        peakValue = 0n;
      } else if (fill.side === 'buy' && fill.status === 'rejected') {
        buyPending = false;
      } else if (fill.side === 'sell' && fill.status === 'filled') {
        sellPending = false;
        peakValue = 0n;
      } else if (fill.side === 'sell' && fill.status === 'rejected') {
        sellPending = false;
      }
    }

    const bar: Bar | undefined = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // No bar this minute: decide nothing.
    if (state.warmingUp) {
      // Warm-up batches build history but never trade; still record the bar.
      highs.push(Number(bar.h));
      lows.push(Number(bar.l));
      return [];
    }

    const held = state.positions.get(SYMBOL);
    const close = Number(bar.c);

    if (held !== undefined && held.qty > 0n) {
      // Holding: record the bar, then read the exits on its close.
      highs.push(Number(bar.h));
      lows.push(Number(bar.l));
      const value = state.value(SYMBOL, held.qty);
      if (value > peakValue) peakValue = value;
      const lowM = lowestLow(EXIT_BARS);
      const stopHit = value * 10000n <= held.cost * BigInt(10000 - STOP_BPS);
      const trailHit = peakValue > 0n && value * 10000n <= peakValue * BigInt(10000 - TRAIL_BPS);
      const donchHit = lowM !== null && close < lowM;
      const equityGuardHit = state.equity * 10000n < BigInt(state.hello.capital.quote_units) * BigInt(EQUITY_GUARD_BPS);
      if (!sellPending && (stopHit || trailHit || donchHit || equityGuardHit)) {
        if (equityGuardHit) halted = true;
        sellPending = true;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: EXIT_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: the breakout is read against the bars before this one, then this
    // bar is recorded. A flat bar cannot break out (its close equals the
    // highs around it), and a gap adds nothing.
    const breakoutHigh = highestHigh(BREAKOUT_BARS);
    highs.push(Number(bar.h));
    lows.push(Number(bar.l));
    if (halted || entered || buyPending) return [];
    if (highs.length - 1 < WARM_BARS) return []; // Need at least 20 bars of history.
    if (breakoutHigh === null) return [];
    if (close > breakoutHigh) {
      const cash = state.cash;
      if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      buyPending = true;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    return [];
  },
});
