# AI in One browser demos

Two public, static, sample-only bundles. No tenant, sign-in, upload, backend or
administrator operation is available. Production sources are unchanged.

| Bundle | Source UI | Intended site path |
|---|---|---|
| App | Existing React app, including its original styling and 15 views | `/demo/ai-in-one/` |
| Report | Shipping Power BI presentation metadata, 17 visible pages, rendered in the browser | `/demo/ai-in-one-report/` |

## Provenance

Repository: `https://github.com/microsoft/AI-in-One-Dashboard`.
The adapted demo source is published on the
`keithmcgrane-microsoft-shareable-dashboard-demos` branch of
`https://github.com/Keithland89/AI-in-One-Dashboard`, an existing fork of that
upstream repository. Each bundle records this separately as `demoSourceRepository`.
Source/base revision: `e0a77c2c4cb1f3723c656acfe825fa640c7d31ab`.
The app snapshot comes from `Archive/app`. The report presentation comes from
`templates/AI-in-One-v2.0.0-Local-CSV-Template.pbit`.

All additions/adaptations live in `demos/ai-in-one`. The base revision identifies
the upstream sources, **not a commit containing these demo changes**. Each
bundle's `provenance.json` records whether the demo source is uncommitted, its
source-file hashes, template SHA-256, runtime and build command. `release/bundles.json`
records the packaged file hashes. Keep these records with the delivered files.

## Reproduce

From the repository root, on Windows:

```powershell
Set-Location demos\ai-in-one
npm.cmd ci
npm.cmd run package
npm.cmd run check:bundles
npm.cmd test
npm.cmd run lint
npm.cmd run test:packaged
```

The verified build runtime is Node.js **26.13.0**, npm **11.20.0**, Python
**3.12.10** (`python` on PATH). Vite requires Node 22.12 or later. Dependencies
are pinned by `package-lock.json`. Browser tests use installed Edge locally;
CI uses Playwright Chromium, which must be installed separately in that CI job.

`npm run package` deterministically generates all synthetic CSVs, extracts
presentation-only report metadata, type-checks/builds, then creates:

- `release/demo/ai-in-one/index.html` plus local assets and sample CSVs.
- `release/demo/ai-in-one-report/index.html` plus local assets and sample CSVs.

Copy each **whole directory** into the site's served `demo` directory. URLs use
relative assets, with a sibling app link from the report. Hash navigation works
without a server rewrite. Do not copy the intermediate `dist/report.html` alone.
No new hosting, access changes or deployment commands are included here.

## Data and safety

`scripts/generate-sample.mjs` creates 160 invented directory people, four invented
organisations, 16 invented agents and 40,966 interactions over 182 calendar days.
Ten directory people are deliberately inactive. Addresses use `example.invalid`;
agent/session/message identifiers are invented strings, not production GUIDs.
No export or production input is consumed. Fixture joins and metric totals are
checked by tests. Public files are limited to generated CSVs, local browser
assets, a favicon, provenance and licence notices.

The app retains its incumbent navigation, filters, charts and agent drawers.
The upload UI and deployment integrations are removed from this isolated copy.
The report uses original page order, geometry, titles, typography and colours.
Date, organisation, person, agent, app, rank and agent-profile controls filter
local data; reset, glossary navigation, agent details and monthly comparison
are local browser actions. A restrictive CSP permits only same-origin
connections. Browser tests check all 15 app views and all 17 report pages,
direct links, filters, mobile behavior and absence of off-origin requests,
including attempts to select a live mode via query/storage.

## Report limitations

This is **not a Power BI embed or DAX engine**. It does not claim semantic-model
parity. Calculations adapt existing app helpers and selected original measure
definitions to the invented data. There is no Power BI service dependency.

RLS/disclosure enforcement, licence-history transitions, hierarchical drilldown,
hierarchy administration, export, the Power BI bookmark engine and custom-visual
runtime are unavailable. Tables show their top-level grouping. Dual-axis series
share a browser scale; cross-highlighting is unavailable. Unsupported runtime
actions open an explanation, never an admin endpoint. The original glossary
describes the full report, including unavailable features. The monthly view is
a local comparison, not a reconstruction of every original bookmark state.
The in-demo About panel explains these boundaries.

## Licences

The source app, report presentation and adaptations are distributed under the
repository's MIT licence, copyright Microsoft Corporation. Every bundle includes
`LICENSE.txt` and `THIRD-PARTY-NOTICES.txt` with the installed React, React DOM,
Scheduler, Papa Parse and Vite licences. Software copyright-holder attribution
is legal provenance, not a fixture identity.
