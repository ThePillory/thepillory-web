# County officials: how to fill in `county-officials.json`

The five Calaveras County supervisors are entered by hand. The sync Worker
loads this file from the live site on every run, so the steps are:

1. Edit `county-officials.json` (on GitHub you can use the pencil icon).
2. Fill in one entry per supervisor.
3. Merge to `main`. The next sync picks it up. To load it right away, open the
   manual sync link (see `docs/data-sync.md`).

## Fields

| Field | Required | What to enter |
|---|---|---|
| `district` | yes (already filled) | `"1"` to `"5"` |
| `name` | **yes** | Full name as the county lists it, e.g. `"Jane Q. Example"` |
| `source_url` | **yes** | The official county page that lists this supervisor (must start with `https://`) |
| `last_verified` | **yes** | The date you checked the source, as `YYYY-MM-DD`, e.g. `"2026-09-29"` |
| `office` | no | Defaults to `"Supervisor, District N"` |
| `term_start` | no | `YYYY-MM-DD` if the county publishes it |
| `term_end` | no | `YYYY-MM-DD` if the county publishes it |
| `website` | no | The supervisor's official page, if different from `source_url` |
| `photo_url` | no | An official photo URL (`https://…`) |
| `photo_credit` | no | Who the photo is from, e.g. `"Calaveras County"` |
| `party` | no | Leave blank. County offices in California are officially nonpartisan. |

An entry missing `name`, `source_url` or `last_verified` is **skipped, not
shown**, and the sync log says which district and why. If you empty an entry
later, that supervisor stops showing after the next sync.

# California's statewide offices: `state-executive-officials.json`

The Governor and the other offices California elects statewide (Lieutenant
Governor, Attorney General, Secretary of State, Controller, Treasurer, Insurance
Commissioner, Superintendent of Public Instruction), entered by hand from each
office's official website and loaded on every sync, like the supervisors. Check
them after each election or appointment.

| Field | Required | What to enter |
|---|---|---|
| `office_key` | **yes** (already filled) | A short key for the office, e.g. `"governor"` |
| `office` | **yes** (already filled) | The office's name, e.g. `"Attorney General"` |
| `rank` | no (already filled) | Order on the page: 1 is the Governor |
| `name` | **yes** | Full name as the office's website gives it |
| `source_url` | **yes** | The official page that names this officer (`https://…`) |
| `last_verified` | **yes** | The date you checked it, `YYYY-MM-DD` |
| `term_start`, `term_end` | no | `YYYY-MM-DD`, only if an official source states it. The Governor's term dates name the Governor on bills signed and vetoed; without them, the bill pages say "the Governor". |
| `party` | no | Plain text, exactly as an official source gives it; blank otherwise. The Superintendent is elected on a nonpartisan ballot. |
| `website`, `photo_url`, `photo_credit` | no | As for the supervisors |

An entry missing `name`, `source_url` or `last_verified` is skipped, not shown,
and the sync log says which office and why.
