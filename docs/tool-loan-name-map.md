# Tool Loan Tracker → Field App name map

Confirmed 2026-07-31 from Excel `Tool Loan Tracker.xlsx` + live D1 users/employees.

## Exact matches (Excel name = app display / employee name)

| Excel | App user_id | employee_id | Notes |
|-------|-------------|-------------|--------|
| Abel Herrera | 12 | 2 | |
| Adam Bosquez | 11 | 4 | |
| Arin Ramirez | 17 | 5 | |
| Beto Ortiz | 21 | 15 | |
| Chris Brady | 27 | 26 | |
| Chris Marroquin | 3 | 19 | admin |
| Chris Miller | 6 | 17 | |
| Chuck Dickerson | 7 | 22 | mechanic |
| Jaden DeLaGarza | 19 | 25 | |
| John Alvarado | 28 | 10 | |
| John Williams | 16 | 9 | |
| Justin Lyles | 22 | 1 | |
| Kai Woodruff | 13 | 8 | |
| Kelsie Gomez | 4 | 21 | office |
| Kyle Duffield | 20 | 18 | |
| Nate Torres | 32 | 30 | |
| Noah Maxwell | 26 | 31 | |
| Omar Camacho | 15 | 6 | |
| Robert Gonzalez | 31 | 7 | |
| Wayne McCaskill | 9 | 14 | |

## Confirmed aliases (Excel ≠ app spelling/nickname)

| Excel | App display_name | user_id | employee_id | Rule |
|-------|------------------|---------|-------------|------|
| Bianca Ramirez | Bianca | 5 | 23 | first name only in app |
| Charles Beard | CharlesBeard | 14 | 24 | no space in app |
| Geovany Montes | Geo Montes | 25 | 28 | nickname |
| Kirk Crumbly | Kirk Crumbley | 33 | 3 | spelling: Crumbley |
| Marcus Tover | Marcus Tovar | 18 | 13 | spelling: Tovar |
| Michael Casarez | Mike Casarez | 23 | 11 | Mike |
| Warren Engel | Warren Engle | 30 | 12 | spelling: Engle |
| Kenneth Marroquin | Speedy Marroquin | 8 | 20 | nickname Speedy |
| Jared Esquivel | Lurch Esquivel | 29 | 29 | Lurch = Jared |

## Former employees (not in app) — keep ledger forever

No Field App login; create **person/loan profile without user** (or inactive shell) so balances never disappear.

| Excel | Status | Open balance (from Excel summary) | Action |
|-------|--------|-----------------------------------|--------|
| Jonathan Willie | No longer employed | **$416.06** | Keep; no app user |
| Joseph Valdez | No longer employed | **$137.79** | Keep; no app user |
| Alex Salinas | No longer employed | (import history) | Keep history |
| Andres Ybarra | No longer employed | $0 | Keep history optional |
| Antonio Suarez | No longer employed | (import history) | Keep history |
| Estefan Padilla | No longer employed | $0 | Keep history optional |
| Gabriel Torres | No longer employed | — | Keep history optional |
| Isaac Serna | No longer employed | $0 | Keep history optional |
| Junior Gonzalez | No longer employed | $0 | Keep history optional |
| Leon Suarez | No longer employed | $0 | Keep history optional |
| Robert Watkins | No longer employed | — | Keep history |
| Talon Gonzalez | No longer employed | $0 | Keep history optional |

**Must never drop:** Willie + Valdez open balances (and any other non-zero after recompute from loans − payments).

## App users not on Excel tracker

| App | Note |
|-----|------|
| David Trudeau | No tool-loan history in Excel |
| Eric Gonzalez | Viewer; no history |
| Fleet Admin / Fleet Mechanic | System accounts — ignore for loans |

## Import rules (when building)

1. Match Excel name via this map → `user_id` when present.
2. If no user (former staff) → `tool_loan_person` (or equivalent) with `display_name` + `status = inactive` / `former`, `user_id` null.
3. If they return later → link `user_id` to existing person; **do not** create a second balance.
4. Payments: default type `payroll` unless marked `spiff` (Excel blue was style-only).
5. Balances are always `SUM(loans) - SUM(payments)`, never hand-edited.
