# I Got Tired Of Guessing Which Free LLM To Use So I Built A Scoreboard

*ModelPulseX watches 29 free models from OpenCode Zen and OpenRouter every five minutes and tells you which one is actually fast right now.*

It was 1:47 a.m. and I had three tabs open, one on the OpenRouter models page, one on a Zen key dashboard, and one with a half-written function that needed a free model that would not time out when called from a real user flow. I picked the one with the nice name. It timed out. I picked another. Rate limited. Third one worked, but it took nine seconds to say "PONG" back, which is a long time to wait for four letters.

That night I stopped trusting the model list and started timing it.

That scoreboard is now live. It is called ModelPulseX. If you build with free models, this is for you. If you have ever shipped something on a free tier and watched your demo die on stage, you know the feeling.

## The free tier is great until you need it to work twice

Free models are weird. They are generous and chaotic at the same time, which is both the point and the problem when you are trying to ship something that stays up. OpenRouter lists about twenty free variants on a good day, OpenCode Zen has nine or ten, names shift without notice, and pricing flips from free to paid while your code still points at the old name. One day `laguna-s-2.1` is free in two places, the next it is paid on one and your call fails.

I tried to keep a manual list. Lasted about a week. I also tried trusting provider numbers. Those are often optimistic. Spoiler: they were.

What I needed was simple. Which free model is up right now. How fast did it answer last time. Has it been up for seven days or seven minutes. And is the Zen copy faster than the OpenRouter copy of the same model.

I could not find that in one place. TokenDyno does a solid job for paid boards, and I borrowed a few ideas that actually help (sparklines with hourly medians, the n= hint when samples are sparse, separate axes for TPS and TTFT), but I wanted free-only, both providers head to head, and history you can scroll through for seven days. So I built it.

## What it actually measures

No reported numbers. I time what the browser would see.

Every few minutes, each model gets a live request with streaming on. I note when the request starts, when the first token shows up, and when the stream finishes. From that:

```text
TTFT = first_token_at - started_at
generation_ms = completed_at - first_token_at
TPS = output_tokens / generation_ms
```

TPS uses generation time, not total time. If you include wait time in the math, slow starters look faster than they are. I checked the math against a mocked stream that sent the first token at 120ms and finished at 2120ms with 100 tokens for a clean 50 TPS. Same method TokenDyno uses, same reason.

Each run gets a clear status: `SUCCESS`, `TIMEOUT`, `RATE_LIMITED`, `PROVIDER_ERROR`, `MODEL_UNAVAILABLE`, `STREAM_ERROR`, and a few others. No silent fails. An outage is only marked after three failures in a row, so one blip does not paint a model as down. Uptime is just successes over attempts.

Three fixed prompts keep scores comparable. `short` is `Return exactly: PONG` (about 16 tokens, pure latency). `medium` asks for a 180 to 220 word summary (sustained output). `coding` asks for a Python `solve(nums, target)` plus complexity notes. Short stays with short. I never mix them.

Snapshot from August 23, 2026: 29 free models that actually answered when tested. Nine from Zen, twenty from OpenRouter. A model only appears as free if its pricing is clearly zero for both input and output. If pricing is mixed or missing, I leave it out. You see free. Nothing else.

## The dashboard I actually use

The header is loud on purpose. Caps across the top: LLM PERFORMANCE OBSERVATORY, OpenCode Zen plus OpenRouter FREE MODELS, little live dot. I left it in caps because I like how it looks.

Six little cards sit across the top: free models right now, how many answered in the last check, who is fastest, who starts quickest, who has been most reliable, and how many benchmarks ran in the last day. One glance and you know the state of things.

The leaderboard is the heart. Sortable, not pretty for its own sake. You see the model, the provider badge (violet for Zen, sky for OpenRouter), speed right now and over the last hour, day and week, time to first token, weekly uptime, and a tiny sparkline. Thin data? You get a little n= note so you know not to trust a two-sample average. Error rate, status, last test. All there.

Filters sit right above it: provider, model name, benchmark type, sort, profile. Pick what matters that day. Click any row to pin it, up to four side by side while the board keeps ticking live. Fresh data gets a small live pulse, stale data tells you when the last measurement actually happened. No fake week of history for a model that showed up two hours ago, just "2h of observed data" and honesty.

## Four charts that answer the real questions

Throughput first: seven days, pick your models, pick the window (last hour, day, three days, full week). Hover and you see time, provider, throughput, start time and status.

Then time to first token. Same windows, different story. This is the wait before anything appears, and some models that start fast still finish slow. You see it here.

Reliability is the one I stare at most. One line per model. Solid where it was up, faded where it struggled. Under it: uptime, downtime, incident count, longest outage. First place means nothing if its line looks like a cliff.

Errors last. Stacked bars for timeouts, rate limits, server errors, missing models and streaming issues. You spot a bad provider in seconds without reading a log.

My favorite bit is the same-model comparison. Same model on Zen and OpenRouter, side by side: speed, start time, uptime, error rate. Winner highlighted per metric, recommended provider picked from the numbers. If you are about to hardcode a model name, look here first. I learned that the hard way.

Overall score ties it together. Speed counts most, then start time and reliability, with a smaller slice for consistency, all normalized across free models. Flip the profile, Balanced, Fastest, Lowest Latency, Most Reliable, Coding, and the ranking reweights itself. The cards at the top (Best Overall, Fastest Now, Lowest TTFT and so on) link straight to the measurements that earned them. No mystery math.

## What this is not

Not a paid-model board. Not a place that keeps your prompts or completions. Not a scorer where one LLM judges another (just math).

It also will not give you one true speed. Speed moves with provider load, routing, time of day, and model version. I show medians and I hide a cell until it has enough points (two for 1h, three for 24h, five for 7d). A blank means not enough data yet. That blank is honest.

When a model stops being free, I do not make it vanish. It gets a `Previously Free` badge, I freeze its last seven days, and you still see its last result for a week. That came from a real ask: "if it is not free anymore, show its last result." Made sense. So it stays.

## Try it

The live site is at `https://modelpulsex.vipulgote5.workers.dev`.

If you are picking a free model tonight, do not just take the rank. Open the seven-day TPS and the reliability line. Rank is a summary. The reliability line is the story. I have picked number one before and regretted it because its 1h chart was a cliff.

And if you spot a free model I missed, open an issue on the repo. Discovery runs hourly and on every deploy, but names shift and I still miss edge cases. Help me catch them.

We started at 1:47 a.m. with three tabs and a timeout. Now there is one tab. Still up at odd hours sometimes. But at least the scoreboard is honest.
