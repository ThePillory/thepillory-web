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
