# SQL source contract for the PAX-script-backed Fabric OneLake edition of AI-in-One

This contract is separate from the notebook solution's `aio_v2_publication` contract. The PAX edition does not create, rename or impersonate those tables.

## Published producer

[PAX v2.0](https://aka.ms/PAX-Prerelease) assigns the AIO dashboard's processed Users and activity streams the canonical names `AIO_Users` and `AIO_CopilotInteractions`. The catalog is the shared `Agent365` table when collected.

PAX's Delta writer preserves CSV values as strings and sanitizes forbidden column-name characters (spaces, commas, semicolons, braces, parentheses, newlines, tabs and equals signs) to underscores. It disambiguates collisions with numeric suffixes. The report uses explicit known aliases; it does not replace every underscore with a space.

| Delta field example | Report input |
|---|---|
| `Has_license` | `Has license` |
| `License_Status` | `License Status` |
| `Agent_name` | `Agent name` |
| `Agent_type__A365_` | `Agent type (A365)` |
| `Creator_Id` | `Creator Id` |
| `Developer_Name` | `Developer Name` |
| `Agent_TitleID` | Unchanged |
| `Manager_UserKey` | Unchanged |
| `PersonId_Normalized` | Unchanged |

Ambiguous simultaneous sanitized/canonical columns are rejected. Unknown columns are not automatically renamed.

## Users and activity

- Users require unique, nonblank integer **state UserKeys**, person identity and the PAX license-state fields.
- Activity requires UserKey, Message_Id, ThreadId, InteractionDate, CreationDate, WeekStart, MonthStart, ActivityDate, Is_Sensitive and AgentId, as expected by the shared AIO source model.
- Every activity UserKey must exist in Users. Missing/fractional keys and orphans are rejected.
- Date and logical conversion follows the existing AIO definitions; no alternate IDs are generated. Unknown license values remain governed by the shared tri-state licensing logic.
- Optional `EffectiveDate` and `Manager_UserKey` retain their existing observed-history semantics. Multiple distinct license states for a person are supported; invalid duplicate states remain errors in the shared model.

Catalog normalization preserves the existing supported column variants, metadata provenance and identifier resolution. Missing required catalog columns or unreadable enabled catalogs fail explicitly.

## Publication boundary

PAX commits individual Delta tables and maintains its own publication/recovery state. The SQL endpoint exposes table reads; the canonical data tables alone do not provide the notebook solution's ready marker or an atomic multi-table transaction.

The report validates required schemas, exact integer keys, Users state-key uniqueness, event/state relationships, dates and logical values. Users and catalog do not depend on evaluating activity; activity uses a Users-key-only index and streaming row validation, not a full-activity buffer.

These checks do not prove matching table generations. The reviewed PAX complete-set publication path validates its intended members and destination readback and records acceptance/recovery; it does not make asynchronous SQL visibility an atomic report snapshot. Normal refresh uses one-time connection configuration and the existing PAX/SQL refresh cadence, without recurring customer parameter updates. See [one-time setup and unattended refresh](README.md#one-time-setup-and-unattended-refresh).

## Scope of this source contract

These are consumer input requirements, not proof that every producer destination or table generation has been qualified. A published PAX script does not by itself certify a Fabric-to-AIO generation linkage. The separate Fabric-native PAX Fabric product is not integrated by this source edition.
