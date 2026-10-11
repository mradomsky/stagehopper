# StageHopper — domain glossary

Names the code uses for the things in the domain. Use these words in code, commits, and
reviews; when a term here feels wrong, sharpen it here first.

## Festivals and schedules

**Festival**:
An event with a date range and a timezone, identified by a short write-once `id`.

**Festival record**:
The admin-edited source of truth for one Festival. Every field it holds is public.

**Festivals manifest**:
The public list of every Festival record, rebuilt on each admin write. The manifest entry
*is* the record.

**Timetable**:
A Festival's schedule: Days, each holding Performances on Stages.

**Day**:
A festival day, running from 09:00 to 09:00 the next morning in the Festival's timezone, so a
set starting after midnight belongs to the evening before.
_Avoid_: calendar date

**Performance**:
One set: an artist on a Stage from a start to an end time on a Day.
_Avoid_: slot, act

**Stage**:
A named place Performances happen. Not a managed list; a Stage exists because a Performance
names it. Admin-set colour and display order hang off the Festival record.

**Publish**:
Rebuilding a derived public file (the Festivals manifest or a Timetable) from the source of
truth.
_Avoid_: export, sync

## Rooms and people

**Room**:
A shared space for a group attending one Festival. Its id is either *festival-prefixed*
(`{festivalId}-{suffix}`), which names its Festival, or a *custom id*, which does not.

**Custom id**:
A Room id chosen by its creator, carrying no Festival prefix; the Room's Festival is recorded
separately.
_Avoid_: custom slug, vanity slug

**Visitor**:
A person who is not signed in.
_Avoid_: guest, anonymous user

**Lineup**:
A view of one Festival's Timetable outside any Room, open to anyone.
_Avoid_: guest mode, browse mode

**Pending Pick**:
The one Performance a Visitor tapped on a Lineup, carried through sign-in to become their
first Pick.
_Avoid_: tapped set, guest tap

**Participant**:
A signed-in user who has joined a Room.

**Admin**:
A role on a signed-in user that allows editing Festival records and Timetables and managing
Rooms and users. An Admin can also be a Participant.

**Picks**:
A Participant's per-Performance state in a Room: unmarked, going, or maybe.
_Avoid_: selections, marks

## Notifications

**Reminder**:
A push notification about a Picked Performance, sent before it starts.

**Device subscription**:
One browser or device that has opted in to Reminders.
