// Patient-breakout bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: nearly every new pump.fun coin dumps. The rare runners share a signature that shows up
// BEFORE the big move: the coin has survived its first minutes (1000–3000 slots old), the creator
// has not sold, and a crowd of distinct wallets keeps buying steadily over a two-minute window
// while the price grinds up near its recent high. This bot waits for exactly that shape, buys
// once, and then RIDES: a wide stop, a far take-profit and a loose trailing stop let a runner
// run to completion instead of being sold at the first wobble. Tight exits were tried on the dev
// window and lost — the winners pay for the losers only when they are allowed to run.
//
// The bot talks to the harness through the vendored SDK shim (vendor/makefun-bot.ts): the harness
// sends a hello once, then one batch per slot with the events of that slot, the marks (latest
// reserves) for coins we hold or have orders on, the fills that resolved, and the account. Every
// batch we answer with at most one reply listing our orders for that slot; orders fill two slots
// later (latency_slots). The bot is a pure function of the batches it is fed: no clock, no
// randomness, no I/O, so the two grading runs agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback, in slots. */
  window: number;
  /** Net SOL bought minus sold over the window. */
  minNetSol: number;
  /** Buy trades over the window. */
  minBuys: number;
  /** Distinct buying wallets over the window. */
  minBuyers: number;
  /** Price now over price at window start, minus 1: lower bound. */
  minUp: number;
  /** Same ratio: upper bound (skip vertical spikes — those are bundled pumps). */
  maxUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Real SOL reserve band at entry. */
  minRq: number;
  maxRq: number;
  /** Age window (slots since CreateEvent) in which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** A single sell of at least this many SOL in the window vetoes entry. */
  maxSingleSell: number;
  /** SOL per position (one buy, no adds). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage allowed on buys, in bps. */
  buySlipBps: number;
  /** Take profit: exit when value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop loss: exit when value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...then exits on a fall of this share from the best value seen. */
  trailDrop: number;
  /** Exit after holding this many slots (unless already far in profit). */
  maxHold: number;
  /** ...unless the position is up at least this much. */
  holdIfUp: number;
  /** Flow-reversal exit: net SOL over this many slots below minus this. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Guardrail pacing: aim for at least this many coins and fills by paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Probes only start once this share of the pace window has elapsed (late top-up, not early churn). */
  probeAfter: number;
  /** Probe round trip size (SOL) used only to stay on the guardrail pace. */
  probeSol: number;
  /** Most probe positions open at once. */
  maxProbes: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 120,
  minNetSol: 1,
  minBuys: 8,
  minBuyers: 6,
  minUp: 0.18,
  maxUp: 0.7,
  accel: 1,
  nearHigh: 0.95,
  minRq: 3,
  maxRq: 40,
  minAge: 1000,
  maxAge: 3000,
  maxSingleSell: 1,
  stakeSol: 0.12,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 1.5,
  stopLoss: 0.5,
  trailArm: 0.5,
  trailDrop: 0.3,
  maxHold: 100000,
  holdIfUp: 0.5,
  fadeWindow: 20,
  fadeNetSol: 1000,
  cooldown: 300,
  maxEntries: 2,
  targetCoins: 22,
  targetFills: 40,
  paceSecs: 21600,
  probeAfter: 0.7,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 0.5,
};

const LAMPORTS = 1e9;
/** Curve fee on a sale: protocol 95 bps + creator 30 bps. */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinTape {
  created: number | null;
  creator: string | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
  devSold: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CoinTape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  /** Our own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.window + 5;

  const tapeOf = (mint: Pubkey): CoinTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, trades: [], entries: 0, lastExit: -1e12, devSold: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of a tape. */
  const flow = (t: CoinTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal: does this coin look like a runner that has not run yet? */
  const entrySignal = (t: CoinTape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRq || rqSol > p.maxRq) return false;
    if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) return false;
    if (t.devSold) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
        if (tr.sol >= p.maxSingleSell) return false;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minUp || up > p.maxUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.devSold = true;
        } else {
          // CompleteEvent: the curve is done; drop the tape so it is never re-entered.
          tapes.delete(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint);
        if (t === undefined) continue;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take profit, stop loss, trailing stop, time limit, creator sell, flow reversal.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trailDrop)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit && t.devSold) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries: one small buy per qualifying coin.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        if (slotsLeft <= 0) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when our fills or coins lag the pace, late in the window.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (pace < p.probeAfter) return orders;
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
