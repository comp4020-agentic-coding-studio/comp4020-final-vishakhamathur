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

<!-- TODO: this is a first draft — read it over and put it in your own words
     before the cutoff; it should sound like you, not like your agent. -->
