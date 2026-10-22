# StageHopper — domain glossary

Names the code uses for the things in the domain. Use these words in code, commits, and
reviews; when a term here feels wrong, sharpen it here first.

## Festivals and schedules

**Festival**:
An event with a date range and a timezone, identified by a short write-once `id`. Each
Festival is one open space for everyone: its Timetable, everyone's Picks and its Festival chat.
_Avoid_: room, group, lineup (retired: a Room was a private space per group, a Lineup the
view outside one)

**Festival record**:
The admin-edited source of truth for one Festival. Every field it holds is public.

**Unlisted festival**:
A Festival hidden from the landing page, still reachable by anyone with its URL. Not
private: every field is still published. Used for prospect demos.
_Avoid_: hidden, draft, private

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

## People

**Visitor**:
A person who is not signed in.
_Avoid_: guest, anonymous user

**Pending Pick**:
The one Performance a Visitor tapped on a Festival page, carried through sign-in to become
their first Pick.
_Avoid_: tapped set, guest tap

**Attendee**:
A signed-in user who has Picked a Performance or posted a Message in a Festival. Implicit;
there is no join or leave.
_Avoid_: participant, member

**Nickname**:
A signed-in user's one app-wide name, shown on Picks and Messages. Chosen and changed by the
user in their Profile; two users may share one, so a user is told apart by their id, never by
Nickname. Seeded once from the sign-in username.
_Avoid_: handle (retired: a Handle was the sign-in username), display name, username,
participant name

**Profile**:
A signed-in user's Nickname and Colour. Only the user edits it; both are required before
their first Pick or Message.
_Avoid_: settings, account

**Colour**:
A signed-in user's one app-wide colour, shown on their Picks. Two users may share one.
_Avoid_: claimed colour

**Admin**:
A role on a signed-in user that allows editing Festival records and Timetables, deleting any
Message, and banning users. An Admin can also be an Attendee.

**Banned**:
A signed-in user an Admin has stopped from Picking and posting. They can still read.
Deleting a Banned user removes their Picks, Messages and profile but keeps the ban.

**Picks**:
An Attendee's per-Performance state in a Festival: unmarked, going, or maybe. Visible to
everyone.
_Avoid_: selections, marks

## Chat

**Festival chat**:
The one open conversation per Festival. Readable by everyone, posted to by Attendees.
_Avoid_: channel, room chat

**Message**:
One text post by an Attendee in a Festival chat. Its author or an Admin can delete it; nobody
can edit it. It keeps the Nickname and Colour its author had when posting.
_Avoid_: post, comment

## Notifications

**Reminder**:
A push notification about a Picked Performance, sent before it starts.

**Device subscription**:
One browser or device that has opted in to Reminders.

## Branding

**Theme**:
The four colour tokens a deployment or embed can override: background, surface, text, and
accent (`--sh-bg`, `--sh-surface`, `--sh-text`, `--sh-accent`). Every other UI shade derives
from them; Pick gold, stage colours, and Colours are not part of it.
_Avoid_: skin, palette, branding
