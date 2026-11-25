# Tiny SOL Trend Bot — Beat Buy-and-Hold on Solana

![Bounty](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)
![Rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/muherilobak-web/tiny-sol-bot-20261125/rank.svg)
![Reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/muherilobak-web/tiny-sol-bot-20261125/reward.svg)

Entry for the [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) bounty on make.fun — a paper-trading bot that runs in the `agent-fun/bars-replay/v1` harness (simulation only, no real funds).

## Strategy

The bot is a trend follower on hourly closes across the seven Solana assets (FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF). It enters a fresh fast-over-slow EMA crossover only when the asset's 12-bar return is at least +1.5%, ranks qualifying assets by momentum, and holds at most three positions of 15% of equity each. It exits when the fast EMA crosses back below the slow EMA or when the close falls 5% below the position's peak (trailing stop), and it never re-enters an asset within 12 bars of an exit. When no asset qualifies, it sits in USDC cash — staying out of a downtrend is the whole edge over buy-and-hold.

Final parameters (tuned on the dev window with `grade-local`): fast EMA 8, slow EMA 20, momentum lookback 12 bars, momentum threshold +1.5%, trailing stop 5%, position size 15% of equity, max 3 slots, 12-bar exit cooldown, entries only within 12 bars of the crossover.

## Dev results (grade-local, dev window, 136 hourly bars)

- Net PnL: **-224.80 USDC** vs buy-and-hold baseline **-869.34 USDC** (margin +644.54 USDC)
- Trades: 21 over 7 symbols; max drawdown 2.89% — guardrails met (≥8 trades, ≤25% drawdown)
- Determinism: the grader runs the bot twice; both action logs reproduced byte for byte.

## Run the local grade

From the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

`main.ts` is a single self-contained program: it speaks the NDJSON `hello` / `batch` / `done` protocol from stdin/stdout using only the Node standard library, keeps all money and price math in `BigInt`, and makes no network or file access, so two runs are bit-identical.

Made with [make.fun](https://make.fun/r/bt57jd3y).
