/**
 * PROTOTYPE — throwaway. Fake Festival chat for the three layout variants on
 * `/room/{festivalId}?variant=A|B|C`. Three variants of where the Festival chat lives, on the
 * existing room (browse-mode) route. Nothing here is production.
 */

export interface ProtoMessage {
	id: string;
	handle: string;
	color: string;
	text: string;
	/** HH:MM, display only. */
	time: string;
	mine?: boolean;
}

const seed: Array<[string, string, string, string]> = [
	['joana_lx', '#3498db', '21:40', 'anyone at the main stage yet? how packed is it'],
	['tomásv', '#2ecc71', '21:41', 'pretty full on the left side, right side still has space'],
	['mia.k', '#f39c12', '21:41', 'queue for beer near Stage 2 is like 2 min, go now'],
	['dj_rui', '#9b59b6', '21:43', 'Grace Jones is 00:15 right? not 23:45?'],
	['joana_lx', '#3498db', '21:43', 'yes 00:15, timetable updated this afternoon'],
	['pedro', '#1abc9c', '21:45', 'lost a black cap with a yellow logo near the food trucks 😭'],
	['anna_b', '#e5d62e', '21:48', 'sound on stage 3 is way better than yesterday'],
	['mia.k', '#f39c12', '21:50', 'who else going to Jungle? 🙋'],
	['tomásv', '#2ecc71', '21:50', 'me, meeting at the tree left of the sound desk'],
	['lucas', '#e52e81', '21:52', 'water refill point behind stage 2 is free btw'],
	['dj_rui', '#9b59b6', '21:55', 'ok see you all at the tree'],
	['sofia', '#2ed3e5', '21:58', 'ARE THE SHUTTLES RUNNING AFTER 2AM'],
	['anna_b', '#e5d62e', '21:59', 'last one 02:30 from the north gate'],
	['pedro', '#1abc9c', '22:03', 'found the cap!! thanks whoever put it on the fence'],
	['joana_lx', '#3498db', '22:05', 'ok heading to stage 1 now, it is filling up fast'],
	['max', '#e74c3c', '22:06', 'is the view ok from the back? not fancying the crowd'],
	['lucas', '#e52e81', '22:07', 'screens are big, back is fine honestly'],
	['sofia', '#2ed3e5', '22:09', 'who is the opener on stage 2 at 23:00? not on the timetable'],
	['mia.k', '#f39c12', '22:10', 'secret set apparently 👀'],
	['tomásv', '#2ecc71', '22:12', 'rumour says it is the band from yesterday night'],
	['anna_b', '#e5d62e', '22:15', 'rain forecast says dry until 3, good'],
	['dj_rui', '#9b59b6', '22:16', '🔥🔥🔥'],
	['max', '#e74c3c', '22:18', 'ok going. see you at the tree'],
	['pedro', '#1abc9c', '22:19', 'the tree is becoming a thing lol'],
	['joana_lx', '#3498db', '22:20', 'it is THE tree now']
];

export const PROTO_MESSAGES: ProtoMessage[] = seed.map(([handle, color, time, text], i) => ({
	id: `m${i}`,
	handle,
	color,
	time,
	text,
	mine: handle === 'max'
}));

export const PROTO_HERE_COUNT = 312;
export const PROTO_UNREAD = 3;

/** Lines the "live" simulation appends while the page is open. */
export const PROTO_INCOMING: Array<[string, string, string]> = [
	['sofia', '#2ed3e5', 'at the tree. there are like 40 people here now'],
	['lucas', '#e52e81', 'stage 1 just opened the back barrier, more space'],
	['mia.k', '#f39c12', 'SECRET SET CONFIRMED. go to stage 2'],
	['anna_b', '#e5d62e', 'lights test on stage 1 looks insane'],
	['dj_rui', '#9b59b6', 'ok which tree'],
	['tomásv', '#2ecc71', 'THE tree']
];
