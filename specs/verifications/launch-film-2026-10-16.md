# Launch film — 2026-10-16 (`videos/modelpulsex-launch` + `-vertical`)

First product marketing film for ModelPulseX, built with the HyperFrames
`product-launch-video` workflow. Everything below was run on this machine against these
trees; no figure here is copied from an earlier artifact.

## Review pass — 2026-10-16 (post-release audit, both cuts)

A full review of the delivered MP4s (frame extraction at 13 story beats per cut +
`lint` + `check` + loudness + numbers audit), run against the shipped renders. Findings,
ranked:

**🔴 Blocking — fixed and re-rendered:**

1. **Brand-mark reveal incomplete (both cuts).** The arm draw-on sweeps in `06-lockup`
   ended at `x:-42`, whose 66 px band only covers the arms to x≈24 — the right halves of
   both X arms stayed clipped, so the finished mark read as a ring + two bars instead of
   the real X. Fix: sweep end `x:-42 → 0` (band covers 0–66, arms span 12–52) in both
   `compositions/frames/06-lockup.html`. Verified by snapshot crop: solid cross arm +
   pulse arm with first-token spike, dashed orbit ring with top-right gap, violet→cyan.
2. **Vertical CTA descenders sliced (vertical only).** `modelpulsex.pages.dev` lost the
   tails of "p"/"g" to a razor edge: `line-height:1` plus the fully-open wipe `clip-path`
   clips to the border box. Fix: `line-height:1 → 1.18` on `.f06-lockup-cta-url`.
   Verified by full-res crop: all descenders whole.

**🟠 Important — fixed and re-rendered:**

3. **Seek-correctness warnings (both cuts).** Two `tl.fromTo()` calls shared
   `#cmp04-lnum` / `#v04-lnum` with no baseline, so pre-first-tween seeks rendered the
   wrong resting state. Fix: `immediateRender:false` on the later (5.30 s) tween in both
   `compositions/frames/04-compare.html`. Lint warnings 8 → 7 per project.
4. **Vertical headline safe margins (vertical only).** "Meet ModelPulseX." at 92 px from
   4cqw sat ~0–3 px off the canvas edge under the camera's 1.10 peak push. Fix:
   `left:4cqw → 7cqw`, `font-size:92 → 84px` (headline + subline, kept aligned); ≥28 px
   margin at peak zoom, line still ends well short of the right edge. Verified by crop.

**Accepted as-is (deliberate, verified):**

- `duplicate_media_discovery_risk` (04-compare row-band slices, both cuts): intentional
  slice technique; renders verified pixel-correct, `check` passes.
- Transition-midpoint ghosting (crossfade/zoom-through middles at 9.2/14.2/28.2 s):
  0.4–0.6 s of double exposure is the approved transition language, clean on both sides.
- Mid-count values (e.g. 2,718 at 18.5 s): the counter lands 2,722 at 18.6 s and holds;
  numbers audit passes on both cuts (66/66 tokens traced).
- Vertical 03 full-bleed leaderboard crop cuts in column gutters; settled state verified
  with all figures legible.

**Scores after fixes** (hook / readability / motion / variety / brand / sound):
16:9 → 8 / 9 / 8 / 8 / 10 / 9. 9:16 → 8 / 9 / 8 / 8 / 10 / 9.
Scores: hook 8 (cue-paced ignite is deliberate, not sparse); readability 9 (phone-size
demo numerals hold; only transient scroll states are dense); motion 8 (grammar consistent,
holds respected); variety 8 (six distinct blueprints, no repeated template); brand 10
(verbatim geometry, tokens, type); sound 9 (−14.7 LUFS, beat-grid SFX, reads muted).

**Improvements shipped in this pass:** poster frames for embed/thumbnail use
(`renders/poster-*.jpg`: the proof beat + the lockup, both cuts); this addendum.

Re-gates after fixes: `lint` 0 errors both cuts · `check` passed both cuts (contrast
64/64 and 57/57 AA) · numbers audit ✓ both cuts · renders re-encoded + loudness
re-normalised to −14.7 LUFS / TP −1.4 · probes confirm geometry/codecs/duration.

## Deliverables

| File | Canvas | Duration | Codecs | Loudness |
| --- | --- | --- | --- | --- |
| `videos/modelpulsex-launch/renders/modelpulsex-launch-1920x1080.mp4` | 1920×1080 | 35.0 s program (35.1 s container) | h264 yuv420p 30 fps · AAC 48 kHz stereo | −14.7 LUFS, TP −1.4 dBTP |
| `videos/modelpulsex-launch-vertical/renders/modelpulsex-launch-1080x1920.mp4` | 1080×1920 | 35.0 s program (35.1 s container) | h264 yuv420p 30 fps · AAC 48 kHz stereo | −14.7 LUFS, TP −1.4 dBTP |

Both cuts share one score, one set of 29 SFX cues and identical frame boundaries, so the
two films can be cut against the same audio if a shorter edit is ever needed.

## Story

Six beats, 35 s: **hook** (the landscape of real models ignites) → **problem** (measured
drift: throughput, latency and reliability move independently) → **product intro** (the
field resolves into the live dashboard) → **demo** (the three pinned models compared, the
latency gap, seven days of throughput, the product's own recommendation) → **digital twin**
(each node unfolds into its real stat row and seven-day trace) → **brand + CTA**
(`modelpulsex.pages.dev`, held readable).

The one story the captured data gave us, and the only claim the film makes:

| Model | Provider | TPS 7d | TTFT 7d | Uptime 7d | Err |
| --- | --- | --- | --- | --- | --- |
| openai/gpt-oss-safeguard-20b | groq | 1128.0 | 277 ms | 96.4% | 3.6% |
| openai/gpt-oss-20b | groq | 1125.7 | 331 ms | 100.0% | 0.0% |
| google/diffusiongemma-26b-a4b-it | nvidia | 1012.8 | 2722 ms | 94.6% | 5.4% |

Comparable 7-day throughput (1125.7 vs 1012.8, 11 % apart) with an **8.2× gap in
time-to-first-token** (331 ms vs 2722 ms). `capture/data/compare.json`; no other claim is
made and no provider is framed as inferior.

## Gates run

| # | Gate | Command | Result |
| --- | --- | --- | --- |
| 1 | Workspace baseline | `npm test && npm run typecheck && npm run lint` | 33 files / **311 tests** pass · tsc exit 0 · eslint exit 0 |
| 2 | Capture gate | `npx hyperframes capture "https://modelpulsex.pages.dev/#/?compare=38,34,69"` | complete; `capture/BLOCKED.md` absent; tokens + text + asset inventory present |
| 3 | Design system | `build-frame.mjs --preset cobalt-grid --tokens ./brand-tokens.json` | exit 0, self-check passed, ink/canvas contrast ok |
| 4 | Storyboard | `STORYBOARD.md` | 6 frames, every frame with `type`/`persuasion`/`beat`/`blueprint`/`asset_candidates` + a time-coded shot sequence, `## Video direction` written once |
| 5 | Packets | `frame-packets.mjs` | 6 bounded packets (32–45 KB) + worker role payload |
| 6 | Frames | 6 workers (16:9), 6 workers (9:16) | 12 files, every one a bare `<template>` with a registered paused timeline |
| 7 | Assembly | `assemble-index.mjs` | 6 frames · bgm yes · 29 SFX · 15/15 assets staged · **35 s, +0 s vs brief** |
| 8 | Transitions | `transitions.mjs inject` + `verify` | 5 transitions stamped and verified (cross-track, overlap > 0, no same-track overlap) |
| 9 | Async check | `npx hyperframes lint` / `check` | **0 errors** each cut; runtime 0 errors; motion 0 errors; **contrast 64/64 (16:9) and 57/57 (9:16) WCAG AA** |
| 10 | Snapshots | `npx hyperframes snapshot --at …` | contact sheets inspected at every frame midpoint, every cut ±0.1/0.2 s, the hook's first second and the closing hold |
| 11 | Accuracy | `node scripts/audit-numbers.mjs` | ✓ every on-screen number traces to `capture/data/` or a documented derived fact |
| 12 | Render audit | `ffprobe` / `blackdetect` / `freezedetect` / `loudnorm` | 1920×1080 yuv420p 30 fps 35.000 s, audio present, no black or frozen stretch, −14.7 LUFS / TP −1.4 dBTP |

Defects found by these gates and fixed before render, not worked around: two `fontSize`
tweens (layout-snapping) in frame 4 → transform tweens; 14 contrast failures (violet text
below 4.5:1) → the brand's light violet; text occluded by frame 3's particle canvas →
canvas moved behind the type; the portrait cut's copy rail clipping a 6 px sliver of the
next cue → offset raised; the portrait frame 3 crop cutting a word at the canvas edge →
crop origin re-solved against the device box offset.

## What the film is built from

- **Real captures only.** 24 live-UI plates (`capture/plates/`, 2× for punch-ins) plus the
  raw API responses in `capture/data/` (`compare`, `leaderboard-7d`, three model histories,
  `providers`, `health`). Provenance and capture-time freshness: `capture/CAPTURE-NOTES.md`.
- **The product's own brand.** `frame.md` is the shipped `cobalt-grid` preset remixed onto
  the product's real tokens (canvas `#0a0a0f`, ink `#F4F4F5`, accent violet `#8b5cf6`, second
  accent cyan `#22d3ee`, the six data-series hues, Inter + JetBrains Mono from
  `assets/fonts/`). The mark is the real `frontend/public/logo.svg` geometry — drawn on, never
  redrawn.
- **Reused registry blocks**, adapted into the frames rather than rebuilt:
  `constellation-hub`, `decline-chart`, `particle-image-reveal`, `grain-field`, `push-in`,
  `mk-line-graph`.
- **Code-synthesized audio** (`scripts/synth-audio.mjs`, deterministic mulberry32, 120 BPM so
  every scene boundary lands on a beat; 35 s bed + 29 cues) declared as host audio in
  `audio_meta.json`.

## Known limitations — state them, don't paper over them

1. **Capture-time freshness.** At capture (`2026-10-16 06:04 UTC`) the measurement pipeline
   had not written a new run for 58 minutes, so the dashboard's own freshness strip was in its
   STALE state. The film's hero surfaces never include that strip (the one plate that would
   have was cropped below it, reproducibly, from the same command), the film claims no
   "live right now", and every figure is stated as the 24 h/7 d median it is. Re-capturing is
   one command; see `capture/CAPTURE-NOTES.md` for why the frames' measured geometry must be
   re-verified after a re-capture.
2. **Portrait frame 3 at the zoom peak** clips the rightmost leaderboard column at the canvas
   edge for ~0.4 s while the camera is moving. The left edge — where a cut reads as a broken
   word — is clean in both cuts.
3. **The 16:9 and 9:16 cuts are independent compositions.** A copy change must be applied
   twice; they share assets, score and cue times, not markup.

## Editing

```bash
cd videos/modelpulsex-launch           # or -vertical
npx hyperframes preview --background   # Studio, then preview --stop
npx hyperframes check                  # after any frame edit
npx hyperframes snapshot --at 2,6.5,11.5,18.5,25.5,31.5,33.95
npx hyperframes render --skill=product-launch-video --quality high --output renders/video.mp4
```

Frames are one file each (`compositions/frames/NN-*.html`), so a revision names a single
frame id (`01-landscape` … `06-lockup`). The story, copy, asset list and shot sequences live
in `STORYBOARD.md`; the look lives in `frame.md`.
