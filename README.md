# pumpfun-replay-sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Tuapaaas/pumpfun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Tuapaaas/pumpfun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A patient-breakout paper-trading bot for the pump.fun replay (agent-fun/replay/v2): it trades 10 SOL of paper money on 24 hours of recorded pump.fun bonding-curve activity. It only buys coins that have survived their first minutes (1000–3000 slots old) and show sustained, broad-based buying with the creator still holding, enters once (0.12 SOL), and then rides: a wide stop, a far take-profit and a loose trailing stop let a runner run to completion instead of being sold at the first wobble. A late-window probe mechanism tops the coin count up to the 20-coin guardrail.

## Strategy

Nearly every new pump.fun coin dumps. The rare runners share a shape that shows up before the big move: the coin has survived its first minutes (1000–3000 slots old), the creator has not sold, and a crowd of distinct wallets keeps buying steadily over a two-minute window while the price grinds up near its recent high. Entry needs, over a 120-slot window: net inflow ≥ 1 SOL, ≥ 8 buy trades, ≥ 6 distinct buyers, price up 18–70% and within 5% of the window high, accelerating inflow, real SOL reserves 3–40, age 1000–3000 slots, no creator sale, no single sell ≥ 1 SOL. Exits: take-profit +150%, stop-loss −50%, trailing stop (arms at +50%, exits on −30% from peak). Tight exits were tried on the dev window and lost — the winners pay for the losers only when they are allowed to run.

## Local grading (dev window, `grade-local --driver process`)

Net **+0.2607 SOL** (return +2.6%), 85 fills, 33 coins, 43 round trips, win rate 18.6%, max drawdown 2.3%, guardrails met. The pilot momentum baseline scores −9.38 SOL and the pilot sniper −0.14 SOL on the same window; the equal-weight baseline −0.019 SOL. Honest caveat: the gains concentrate in 3 coins (80% of gains) and the 90% interval is wide (−0.30…+0.91 SOL), so the final window is a lottery ticket with a positive dev score — as pump.fun edges go, that is the honest shape of it.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts`; the bot speaks agent-fun/replay/v2 on stdin/stdout through the vendored SDK shim (`vendor/makefun-bot.ts`, byte-identical to the kit's `sdk/ts/makefun-bot.ts`). The strategy lives in `strategy.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=c1kkm475&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
