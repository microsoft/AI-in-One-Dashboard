<!-- impeccable:product-schema 1 -->
# AI in One — App Edition

## Platform
Web app, hosted as a Copilot Studio / Cowork **Managed App** (Copilot Managed Runtime). Desktop first (1280–1600px), usable down to 390px.

## Users
- **Adoption and change leads** who track Microsoft 365 Copilot, Copilot Chat and agent rollout across the organisation, report progress to leadership, and decide where to focus enablement.
- **IT admins and licence owners** who decide which licensed users are inactive and which unlicensed Copilot Chat users should be prioritised for a licence.

They are fluent in Microsoft 365 and familiar with the Power BI edition. They open the app weekly or monthly, often while preparing a review meeting.

## Purpose
An app version of the AI in One Power BI dashboard. It keeps **the same information as the PBI** (every metric, chart and table, with the same DAX definitions), presented with simpler navigation: six top tabs with short sub-views instead of fifteen report pages.

## Data
- PAX exports (Purview audit interactions, Entra users with licensing, optional Agent 365 inventory) as CSV.
- All parsing and metric calculation happens in the browser. Data never leaves the tenant.
- A synthetic sample is bundled and is always clearly labelled as sample data.

## Constraints
- Metric definitions must match the PBI's DAX. Any deliberate adaptation is listed in the Guide.
- Privacy: session-by-agent visuals only show agents with three or more users.
- No external CDNs, fonts or network calls. The Managed Runtime CSP blocks them.
- Accessibility: WCAG AA contrast, keyboard reachable controls, visible focus.

## Brand and tone
Microsoft-adjacent, calm and analytical. A dark-teal header band and a white working surface, following the "Copilot Costs Central" reference. Plain English labels; numbers are the hero.

## Anti-goals
- No marketing hero, no decorative gradients, no illustration.
- No dashboards-of-cards-inside-cards.
- Don't drop any PBI metric to "simplify". Simplify by grouping and navigation instead.
