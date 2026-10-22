---
name: AI in One (App Edition)
description: Calm analyst workspace for Copilot and agent adoption, computed in the browser from PAX exports.
colors:
  canvas: "#f3f6f5"
  surface: "#ffffff"
  surface-2: "#f7faf9"
  ink: "#12201e"
  ink-2: "#445653"
  ink-3: "#5f716e"
  line: "#d9e2e0"
  line-2: "#e9efed"
  band: "#0b3d3a"
  band-ink-2: "#b9d3cf"
  band-accent: "#7fe0cf"
  accent: "#0f766e"
  accent-ink: "#0b5a52"
  accent-soft: "#e6f3f0"
  hover: "#eef5f3"
  licensed: "#0f766e"
  unlicensed: "#b45309"
  agent: "#6d28d9"
  bad: "#b42318"
typography:
  page-title:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  kpi-value:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.15
    fontFeature: "tnum"
  panel-title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: 1.45
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  pill: "999px"
spacing:
  gutter: "16px"
  page-x: "28px"
  page-x-mobile: "14px"
components:
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "16px 18px 18px"
  kpi:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "14px 16px 15px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "36px"
  segmented-on:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "32px"
  table-header:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-2}"
---

# DESIGN.md: AI in One (App Edition)

> Recorded from the shipped build in `src/index.css`, `src/ui/theme.ts` and the components in `src/ui/`. The impeccable documenter ran inline in degraded mode (no subagent), so the qualitative language here was written without a user interview.

## Overview

**North star: the analyst's workbench.** A quiet, light workspace where the numbers carry the colour. One dark-teal band at the top holds the brand, the data source and the six tabs. Everything below it is white panels on a pale green-grey canvas.

Navigation has three levels, always in the same place:
1. Top tabs: Overview, M365 Copilot, Copilot Chat, Agents, Licence priority, Guide.
2. Segmented sub-views under the page title: Trends, Leaderboard, Habits, Health check, Use cases.
3. Filters in the toolbar. Only the filters relevant to the tab appear, and a set filter is tinted.

## Colors

- **Colour means something.** Teal `licensed` is M365 Copilot (licensed users), amber `unlicensed` is Copilot Chat (unlicensed users), violet `agent` is agents. Use them only for those populations, in KPI dots, bars, lines and bubbles.
- `band` is used for the header only. `band-accent` is used only for the active-tab underline and focus rings inside the band.
- `accent` (same hue as `licensed`) handles interactive states: primary buttons, active sort arrows, set filters and selected bar rows.
- Ordinal data uses the teal ramp in `theme.ts` (`RAMP`, `RANK_RAMP`), never a rainbow.
- SVG chart colours are constants in `theme.ts`. SVG presentation attributes don't resolve CSS variables reliably inside the Managed App host.

## Typography

- The Segoe UI Variable family is used throughout: Display for page titles, KPI values and sheet titles; Text for everything else.
- Every number that lines up uses `font-variant-numeric: tabular-nums`: KPI values, table numbers, bar values and axes.
- The ramp is small: page title 21px, section title 16px, panel title 15px, body 14px, and labels and notes 12.5px. Sentence case everywhere, with no uppercase eyebrows.

## Layout

- The content column has a max width of 1480px with 28px side padding, dropping to 14px at 600px and below.
- **KPI row:** a flex-wrap row of tiles with a 170px minimum each. Text-valued KPIs ("Most popular agent") take double width.
- **Panel grids:** `grid-2`, `grid-3`, `grid-2-1` and `grid-1-2` with a 16px gap, aligned to the top so panels never stretch to empty height.
  - Wide tables always get the full width. Never put a table of five or more columns in the narrow column of a split.
- Grid tracks that contain charts must be `minmax(0, 1fr)`. Charts measure their own width, and an `auto` track locks them at their first measured size.
- **Breakpoints:**
  - 1100px: three-column grids become two.
  - 900px: every grid becomes one column, and the toolbar stacks.
  - 600px: filters become a two-column grid, and KPIs become two per row.
  - Tables scroll horizontally inside their own frame.

## Elevation & Depth

The design is mostly flat. Panels and KPIs use a 1px `line` border plus a hairline shadow (`0 1px 2px rgb(16 40 37 / .06)`). Tooltips, info pops and dialogs use the only real elevation, `0 8px 28px rgb(16 40 37 / .18)`. There are no nested cards: sub-areas inside a panel use `surface-2` fills (stat grid, file drop) instead of another bordered box.

## Shapes

- Panels and KPIs use 10px radius, controls 7–8px, and bars 2–3px.
- Pills (999px) are reserved for status: the source chip, the review tag and the kid count.
- Rank pills use a 6px radius and amber, to tie them to the unlicensed population.

## Components

- **KPI tile:** a coloured population dot plus a label, with an info button carrying the PBI glossary text. Below that, the value, then a sub-line with context (the period, or "of N licensed"). Trends are green when up and red when down.
- **Panel:** a title (and optional note) on the left and an info button. The body comes next. The note explains what the visual counts, in plain words.
- **BarList:** a ranked label, a track and a right-aligned value in a three-column grid. Rows can be clicked to filter or open a drawer, and the selected row is tinted `accent-soft`. "Show all N" expands it.
- **DataTable:**
  - Fixed layout, sortable headers, search, and an Org > Person tree with a twisty and a child count.
  - Numbers are right-aligned and tabular. In-cell bars sit in a grey track next to their value.
  - Text columns that can be long (description, features) clamp to two lines.
  - "Show more" pages through the rows 25 at a time.
- **Side sheet:** a native `<dialog>`, 460px, fixed to the right edge, used for agent details. **Centred sheet:** used to change the data source.
- **Segmented control:** a grey trough; the active segment is white with a hairline shadow.
- **Focus:** a 2px `accent` outline with a 2px offset everywhere, and `band-accent` inside the header band.

## Do's and Don'ts

**Do**
- Keep every Power BI metric. Reorganise it into tabs and sub-views; don't drop it.
- Put the definition of each metric behind its info button, sourced from the glossary.
- Keep the six top-level tabs. New content goes into a sub-view.

**Don't**
- Use eyebrow labels, gradient text, or side-stripe accents thicker than 1px.
- Use population colours for decoration.
- Add motion beyond the sheet entrance and the spinner. Respect `prefers-reduced-motion`.
- Show per-agent session data for agents with fewer than 3 users (privacy floor).
