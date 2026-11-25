// Tiny trend bot for the Solana bars-replay contest.
// Concept: sit in cash unless an asset shows a clear hourly uptrend,
// then ride it with a fixed share of equity and exit on reversal.
// Strategy (Concept 1): fast/slow EMA crossover on hourly closes plus
// a momentum filter, rotating into the strongest-momentum assets, with
// a trailing stop as the safety exit. All money and price math uses
// BigInt on the harness scales; every decision is a pure function of
// the bars and account state in the batch messages, so two runs agree.

import * as readline from "node:readline";

// --- Tunable strategy parameters (chosen by grade-local tuning) ---
const FAST_PERIOD = 8;
const SLOW_PERIOD = 20;
const MOM_LOOKBACK = 12;
const MOM_MIN_BPS = 150; // require +1.5% over the lookback window
const TRAIL_BPS = 500; // exit if close falls 5% below the position peak
const POS_BPS = 1500; // each new position is 15% of equity
const MAX_SLOTS = 3;
const EXIT_COOLDOWN_BARS = 12;
const MAX_SLIPPAGE_BPS = 50;

const SCALE = 1000000n; // fixed-point scale for EMA state

type ScaleInfo = { priceScale: number; qtyScale: number };

type AssetState = {
  closes: bigint[];
  emaFast: bigint; // close * SCALE
  emaSlow: bigint; // close * SCALE
  peak: bigint; // highest close seen while holding, 0n when flat
  lastExitSeq: number; // seq of the last sell decision, for cooldown
};

const symbols = new Map<string, ScaleInfo>();
const assets = new Map<string, AssetState>();
let quoteScale = 6;
let warmupBars = 0; // bars before trading opens, from hello
let maxWeightBps = 2500;
let maxOpenPositions = 10;
let maxOrdersPerBar = 16;
let minNotional = 0n;
const pendingBuy = new Set<string>();
const pendingSell = new Set<string>();

function emaUpdate(prev: bigint, price: bigint, period: number): bigint {
  // ema = price * 2/(n+1) + prev * (n-1)/(n+1), in fixed point.
  const n = BigInt(period);
  return (2n * price * SCALE + (n - 1n) * prev) / (n + 1n);
}

function stateFor(symbol: string): AssetState {
  let st = assets.get(symbol);
  if (st === undefined) {
    st = { closes: [], emaFast: 0n, emaSlow: 0n, peak: 0n, lastExitSeq: -1000000 };
    assets.set(symbol, st);
  }
  return st;
}

function handleHello(msg: any): void {
  quoteScale = msg.capital.quote_scale as number;
  warmupBars = (msg.warmup_bars as number) || 0;
  maxWeightBps = msg.caps.max_weight_bps as number;
  maxOpenPositions = msg.caps.max_open_positions as number;
  maxOrdersPerBar = msg.caps.max_orders_per_bar as number;
  minNotional = BigInt(msg.fees.min_notional_quote_units as string);
  for (const s of msg.symbols as any[]) {
    symbols.set(s.symbol as string, {
      priceScale: s.price_scale as number,
      qtyScale: s.qty_scale as number,
    });
  }
}

function momentumBps(st: AssetState): bigint {
  const n = st.closes.length;
  if (n <= MOM_LOOKBACK) return -1000000n;
  const now = st.closes[n - 1];
  const then = st.closes[n - 1 - MOM_LOOKBACK];
  if (then === 0n) return -1000000n;
  return ((now - then) * 10000n) / then;
}

function handleBatch(msg: any): any[] {
  const seq = msg.seq as number;
  const orders: any[] = [];

  // Clear pending flags for orders whose fills arrived in this batch.
  for (const f of msg.fills as any[]) {
    if (f.side === "buy") pendingBuy.delete(f.symbol as string);
    if (f.side === "sell") {
      pendingSell.delete(f.symbol as string);
      const st = assets.get(f.symbol as string);
      if (st !== undefined) {
        st.peak = 0n;
        st.lastExitSeq = seq;
      }
    }
  }

  const held = new Map<string, string>(); // symbol -> qty string
  for (const p of msg.account.positions as any[]) {
    held.set(p.symbol as string, p.qty as string);
  }
  const equity = BigInt(msg.account.equity_quote_units as string);
  const cash = BigInt(msg.account.cash_quote_units as string);

  // Update per-asset price state from this batch's bars.
  const closesNow = new Map<string, bigint>();
  for (const b of msg.bars as any[]) {
    const symbol = b.symbol as string;
    const close = BigInt(b.c as string);
    closesNow.set(symbol, close);
    const st = stateFor(symbol);
    st.closes.push(close);
    if (st.closes.length === 1) {
      st.emaFast = close * SCALE;
      st.emaSlow = close * SCALE;
    } else {
      st.emaFast = emaUpdate(st.emaFast, close, FAST_PERIOD);
      st.emaSlow = emaUpdate(st.emaSlow, close, SLOW_PERIOD);
    }
    if (held.has(symbol)) {
      if (st.peak === 0n || close > st.peak) st.peak = close;
    } else if (!pendingBuy.has(symbol)) {
      st.peak = 0n;
    }
  }

  // --- Exits: trend reversed, or trailing stop hit. ---
  for (const [symbol, qty] of held) {
    if (pendingSell.has(symbol)) continue;
    const st = assets.get(symbol);
    if (st === undefined) continue;
    const close = closesNow.get(symbol);
    if (close === undefined) continue;
    const reversed = st.emaFast < st.emaSlow;
    const stopped =
      st.peak > 0n && close * 10000n < st.peak * BigInt(10000 - TRAIL_BPS);
    if (reversed || stopped) {
      orders.push({
        side: "sell",
        client_id: `s${seq}-${symbol}`,
        symbol,
        qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingSell.add(symbol);
    }
  }

  // --- Entries: uptrend + positive momentum, strongest first. ---
  // No entries during the harness warm-up: those orders are rejected.
  const freeSlots = Math.min(
    MAX_SLOTS,
    maxOpenPositions,
    maxOpenPositions - held.size,
  );
  if (seq >= warmupBars && freeSlots > 0 && orders.length < maxOrdersPerBar) {
    const candidates: { symbol: string; mom: bigint }[] = [];
    for (const [symbol, st] of assets) {
      if (held.has(symbol)) continue;
      if (pendingBuy.has(symbol)) continue;
      if (pendingSell.has(symbol)) continue;
      if (st.closes.length < SLOW_PERIOD) continue;
      if (seq - st.lastExitSeq < EXIT_COOLDOWN_BARS) continue;
      if (!closesNow.has(symbol)) continue;
      if (st.emaFast <= st.emaSlow) continue;
      const mom = momentumBps(st);
      if (mom < BigInt(MOM_MIN_BPS)) continue;
      candidates.push({ symbol, mom });
    }
    candidates.sort((a, b) => (a.mom > b.mom ? -1 : a.mom < b.mom ? 1 : 0));
    let plannedSpend = 0n;
    for (const cand of candidates.slice(0, freeSlots)) {
      if (orders.length >= maxOrdersPerBar) break;
      let notional = (equity * BigInt(POS_BPS)) / 10000n;
      const capByWeight = (equity * BigInt(maxWeightBps)) / 10000n;
      if (notional > capByWeight) notional = capByWeight;
      const cashLeft = cash - plannedSpend;
      if (notional > cashLeft) notional = cashLeft;
      if (notional < minNotional) continue;
      orders.push({
        side: "buy",
        client_id: `b${seq}-${cand.symbol}`,
        symbol: cand.symbol,
        notional_quote_units: notional.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingBuy.add(cand.symbol);
      plannedSpend += notional;
    }
  }

  return orders;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      handleHello(msg);
    } else if (msg.type === "batch") {
      const orders = handleBatch(msg);
      const reply = { type: "reply", seq: msg.seq, orders };
      process.stdout.write(JSON.stringify(reply) + "\n");
    } else if (msg.type === "done") {
      break;
    }
  }
}

main().catch(() => {
  process.exit(1);
});
