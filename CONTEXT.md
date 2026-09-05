# StageHopper — domain glossary

Names the code uses for the things in the domain. Use these words in code, commits, and
reviews; when a term here feels wrong, sharpen it here first.

- **Festival** — an event with a date range and a timezone, identified by a short
  write-once `id` that every Room id embeds as a prefix.
- **Festival record** — the admin-edited row for a Festival in the `stagehopper-festivals`
  table. Its fields are declared once, in [shared/festival-fields.ts](shared/festival-fields.ts);
  every derived shape (write validator, read guard, manifest projection) comes from that table.
- **Festivals manifest** — the public `data/festivals/index.json` file, rebuilt from every
  Festival record on each admin write. Every record field is public; the manifest entry *is*
  the record.
- **Timetable** — a Festival's schedule: Days, each holding Performances on Stages. Published
  per festival to `data/festivals/{id}/timetable.json`.
- **Performance** — one set: an artist on a Stage from a start to an end time on a Day.
- **Stage** — a named place Performances happen. Not a managed list; a Stage exists because a
  Performance names it. Admin-set colour and display order hang off the Festival record.
- **Room** — a shared space for a group attending one Festival. Its id is
  `{festivalId}-{suffix}`.
- **Participant** — a signed-in user who has joined a Room.
- **Picks** (also *selections*, *marks*) — a Participant's per-Performance state in a Room:
  unmarked, going, or maybe.
