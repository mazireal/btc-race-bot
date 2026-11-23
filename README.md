# Rally Rider — BTC race bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/mazireal/btc-race-bot/rank.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/mazireal/btc-race-bot/reward.svg)](https://make.fun/c/btc-race-24h-20261123-0511)

A BTC trading bot for the make.fun competition
[btc-race-24h-20261123-0511](https://make.fun/c/btc-race-24h-20261123-0511):
it trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain
bars, starting with 1,000 USDC of paper money, long only, for the highest
net PnL over 24 hours.

## Strategy

One trade, ridden well. The dev window's whole gain came from a single fast
rally (+3.1% in hours 3–4) followed by flat chop; every high-frequency rule
tested (EMA 8/21 cross, volatility breakout, RSI/Bollinger mean reversion)
bled fees in the chop and finished deep negative, while this breakout rule
kept its gain.

- **Entry — one buy only.** When a bar's close breaks above the highest high
  of the previous 60 bars (from bar 20 on, using however many bars have been
  seen), buy with 100% of cash.
- **Exits — read on every bar while holding.** Hard stop 2.5% under cost,
  trailing stop 2.5% under the position's peak value, or a Donchian exit
  (close under the lowest low of the last 30 bars). No take-profit and no
  re-entry: the position rides to the end of the window unless a stop fires.
- **Safety.** A global equity guard flattens and halts if equity ever falls
  10% under its start. Buys cap slippage at 100 bps vs the latest close;
  exits cap it at 500 bps, so a stop always fills instead of being rejected
  into a gap-down and retried lower.

## Backtest (kit dev window, 1,440 bars)

| Test | Net PnL | Max drawdown | Trades |
| --- | --- | --- | --- |
| Full dev window | **+30.74 USDC** (+3.07%) | 2.0% | 1 |
| In-sample (bars 0–960) | +26.08 USDC | — | 1 |
| Held-out (bars 960–1440) | −1.89 USDC | — | 1 |
| Mirrored window (crash) | −24.20 USDC | 4.7% | 1 |
| Block bootstrap, 300 windows | median +23.62 USDC, P(PnL > 0) = 0.80 | p90 2.7% | ~1 |

Buy-and-hold on the same window makes +32.17 USDC, so the bot captures
nearly all of the uptrend while its stops cap the loss in a falling market
at roughly the 2.5% stop. Worst single-trade loss is the stop (~$25 plus
~$2.60 of round-trip fees); the bot trades in ~100% of bootstrapped windows,
so it meets the 1-trade guardrail.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only). It speaks
  `agent-fun/bars-replay/v1` through the SDK shim: `hello` once, then one
  `batch` per minute, one `reply` per batch echoing its `seq`.
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's SDK shim.
- `.makefun/owner.json` — claim file for the entry wallet.
