# Maestro web suite

Declarative UI smoke tests for the deployed observatory
(`https://modelpulsex.pages.dev`). Companion to the Playwright gate in
`test/e2e/`, which runs the built bundle against a mock API and can inspect DOM
state (theme attribute, viewport clipping) deterministically.

## Run

With the Maestro CLI installed:

```bash
maestro test maestro/web
```

Or through the Maestro MCP tool with the `chromium` device (the agent uses this):

```json
{ "device_id": "chromium", "dir": "maestro/web" }
```

## Flows

| File | Covers |
| --- | --- |
| `dashboard.yaml` | Dashboard boots; live banner, best-model card, summary, cooldown panel, leaderboard render |
| `navigation.yaml` | Every primary nav target loads its page and its heading |
| `theme.yaml` | Theme control toggles both directions (reload persistence is in the Playwright gate) |
| `model-detail.yaml` | Model detail stats, reliability timeline and the `% hours up` summary |

## Conventions

- Start each flow with a cache-busting query (`?flow=…#/`) so a real page load
  resets the scroll position left by the previous flow.
- Text assertions are exact by default. Use `.*…*` regex when a rendered string
  carries a prefix/suffix (for example `▸ Cooldowns …`).
- Do not assert attributes with `assertTrue` on web: Maestro evaluates it
  outside the page context. Use the Playwright gate for `data-theme`/CSS checks.
- These flows hit production, so keep them read-only (no admin actions).
