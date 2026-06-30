# Bottleneck Suggestion Info Field — Design

**Date:** 2026-06-18
**Status:** Approved

## Goal

Each bottleneck suggestion shown in the suggestion banner gets a hover info
icon ("i") that explains, in plain German, *why* the station was flagged as a
bottleneck — including the station's live utilization and the detection
threshold. This makes the recommendation self-explanatory for students instead
of an opaque "trust me" warning.

## Background

Bottleneck detection lives in `src/metrics/collector.js`,
`calculateMetrics(state)` (lines ~86–122). It aggregates per-machine
utilization (`ticksProcessing / totalTicks`) into a per-station average and
flags every station whose average exceeds `BOTTLENECK_UTIL_THRESHOLD` (0.6).
Each flagged station that still has capacity produces one suggestion object
(`type: 'add-parallel-machine'`) carrying a German `label`.

Suggestions travel to the browser inside the metrics object over the SSE
stream (`/api/events`, `src/server.js`) and are rendered by
`updateSuggestionBanner(metrics)` in `src/public/app.js` (~line 958) into the
`#suggestion-banner` element.

The UI already has a reusable tooltip pattern:
`<span class="info-icon" data-tip="...">i</span>` (styled in
`src/public/style.css`, `.info-icon` / `.info-icon::after`), used for slider
labels, metric cards, and table headers.

## Changes

### 1. `src/metrics/collector.js` — enrich the suggestion object

Where each suggestion is built (~line 118), the per-station `avgUtil` is
already in scope. Carry it into the suggestion and build a German `reason`
string alongside the existing `label`, so all user-facing copy stays in one
place:

```js
suggestions.push({
  type: 'add-parallel-machine',
  stationId,
  machineId: rep.id,
  avgUtil,                            // e.g. 0.95
  threshold: BOTTLENECK_UTIL_THRESHOLD,
  label: `${rep.id} (${rep.name}) ist ein Engpass - passe die Cycle Time an oder füge eine parallele Maschine hinzu, um den Durchsatz zu erhöhen.`,
  reason: `Erkannt, weil Station ${stationId} mit ${Math.round(avgUtil * 100)}% Auslastung läuft — über der ${Math.round(BOTTLENECK_UTIL_THRESHOLD * 100)}%-Schwelle, ab der eine Maschine als Engpass gilt. Auslastung = Anteil der Zeit, in der aktiv bearbeitet wird (nicht blockiert oder wartend).`,
});
```

`avgUtil` / `threshold` are included as raw values too (not just baked into the
string) so future consumers/tests can assert on them without parsing prose.

### 2. `src/public/app.js` — render the info icon

In `updateSuggestionBanner()` (~line 968), append an info icon to each
suggestion row, using `s.reason` as the tooltip text:

```js
`<span class="sg-text">⚠ ${s.label} <span class="info-icon" data-tip="${escapeAttr(s.reason)}">i</span></span>`
```

Add a small `escapeAttr(str)` helper that escapes `&`, `"`, and `<`/`>` before
the value is interpolated into the HTML attribute. The existing static
tooltips are author-controlled and don't need this; `reason` is generated, so
escape it defensively. (Station IDs are config-controlled, but escaping keeps
the rendering robust.)

### 3. `src/public/style.css` — tooltip width for longer text

Reuse `.info-icon` as-is. The `reason` text is longer than existing tooltips,
so verify it doesn't clip or overflow the viewport. If it does, add a
`max-width` and `white-space: normal` to the banner's tooltip (scoped so other
tooltips are unaffected). Only adjust if verification shows a problem.

## Testing

Extend `test/collector.test.js`:

- The existing multi-bottleneck test asserts each suggestion now has a `reason`
  string containing the rounded utilization percentage (e.g. `95%`) and the
  threshold percentage (`60%`), and an `avgUtil` numeric field above the
  threshold.
- Verify a non-bottleneck scenario still yields zero suggestions (no `reason`
  produced).

Manual verification: run the app, drive a station above 60% utilization,
confirm the banner shows the info icon and the tooltip text reads correctly on
hover.

## Out of scope

- The SVG `⚠ ENGPASS` badge, the metrics-table `Engpass` badge, and the detail
  panel `Engpass` label. Those indicate *that* a bottleneck exists; the "why"
  belongs on the actionable suggestion in the banner.
- Changing the detection algorithm or threshold.
