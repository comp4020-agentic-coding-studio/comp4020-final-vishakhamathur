# Crit 10

**What was the breakthrough that moved the work forward?**

Up to crit 9, every analyst in this app was identical — same permissions,
same visibility, no server-side notion of "who are you, specifically." The
brief for crit 10 forced the question I'd been avoiding: if two strangers
open the app from its URL alone, what actually tells them apart on the
server, and what can one of them do that the other can't? Once I stopped
treating "multi-user" as just "many cookies" and asked what a real
permission boundary would look like here, the moderator role fell out
almost on its own — the first person to ever show up gets one extra button,
and the server actually checks that, rather than the UI just choosing not
to show it.

**What did this work change about who I want to be as a software developer?**

Playing with the app after crit 9 made me realize it felt boring and dull —
the UI looked more like an email inbox than something a room of people
would actually want to use together. That's when it clicked that flawless
code doesn't matter if the experience isn't good: a correct permission
boundary and a clean consensus algorithm are worthless if nobody feels
anything while using it. I want to be a developer who builds software that
draws people in and values human emotion and co-presence, not just one who
moves data from a server to a screen correctly.

The other thing this crit sharpened is how I want to work with AI itself. I
built a harness and wrote strict rules for it to follow instead of letting
it implement whatever it wanted — which role gets persisted and why, what
stays pure and testable, what never touches the database outside `/data`.
That goes beyond typing code myself: it's directing, setting boundaries,
verifying the architecture it proposes, and catching it when it
hallucinates instead of trusting it by default. I want to be the kind of
developer who governs AI, not one who gets quietly replaced by it.
