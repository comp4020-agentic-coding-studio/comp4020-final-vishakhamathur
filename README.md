# Cyber Threat Consensus Board

A real-time SOC triage simulator. The server invents plausible-sounding
security incidents — a login spike, an odd outbound transfer, a port scan —
and anonymous "analysts" who show up vote on how severe and how likely each
one is. Votes land on a shared risk matrix live, as they're cast, and once
enough analysts have weighed in (or enough time has passed) the incident
resolves into a consensus score and a true/false-positive call. Analysts who
keep voting against the room's grain pick up an "insider threat" flag over
time.

## Who this is for

Small, synchronous groups: the four or five people in a crit room, a handful
of friends who open the link at the same time to see what the group converges
on. It is not trying to be a real SOC tool, and it doesn't pretend the
incidents are real — the point is watching triage-under-pressure happen as a
social, visible process, not an automated one. At zero visitors the generator
is still quietly inventing incidents nobody looks at; that's fine. This is
software for an afternoon, not a shift roster.

## What "good" means here

1. **Consensus is visible, not just computed.** The risk matrix updates the
   instant someone votes, for everyone watching — the point isn't the final
   score, it's seeing the room converge (or not) in real time. A version of
   this app that only showed the final verdict would miss the thing that
   makes it interesting.
2. **Disagreement is data, not noise.** The "insider threat" flag exists
   specifically so that outlier voting has a visible consequence, the same
   way a real SOC would ask why one analyst keeps calling wolf (or keeps
   waving things through). It only applies after three resolved incidents,
   so one unlucky vote doesn't brand anyone.
3. **Nothing about this needs to be fast or scale.** Per the brief's framing
   of small-scale, low-traffic software: an incident every 45–90 seconds and
   a handful of concurrent voters is the whole expected load. The app is
   built — one SQLite file, one process, no queue, no cache — for that scale
   on purpose, not as a shortcut.
4. **A visitor's trace outlives their visit.** Your analyst codename, your
   agreement rate, and every incident's resolved outcome are still there if
   you close the tab and come back, or if the app restarts. That's the
   multi-user, persistent claim made concrete, not just a line in a spec.

## Using it

Open the app, and you're assigned a codename (e.g. "Agent Crimson Hawk-7")
for the session — no sign-up. Vote severity and likelihood (1–5) on any open
incident with the sliders; the risk matrix and leaderboard update for
everyone live. You can also report your own incident via the form, which
behaves exactly like a generator-made one once it's live. The leaderboard
shows how often each analyst's votes have matched the room's eventual
consensus.

## Roles and permissions

The first analyst the app has ever seen is the **Moderator** — everyone
after that is a regular **Analyst**. The only thing this unlocks is a
"Resolve now" button that ends the active incident immediately instead of
waiting out its countdown; every other action (voting, reporting) works the
same for both roles. The server enforces this itself (a non-moderator's
request to resolve early is rejected with a 403, not just hidden in the
UI), and the reasoning behind who gets the role and why is in `PROCESS.md`.
Every vote, report, and moderator action is written to a persistent,
attributed log that survives restarts — see `PROCESS.md` for how.

## Playing it as a room

Every round, exactly one connected analyst is secretly the **Saboteur** —
everyone sees "ROLE: ANALYST" except that one person, who sees "SECRET
ROLE: SABOTEUR — Drag the consensus off target!" It's social, not
mechanical: nothing about what a Saboteur can submit is different, so the
only way to find them is to watch who's voting oddly and guess. The role
resets every round and isn't tied to anything that survives a restart —
it's a game layer on top of the triage loop, not a new permission. The
15-second countdown ticks audibly in its last 5 seconds and flashes red on
screen, then plays a ding if the room's votes landed close together or a
buzzer if they were scattered.

## What this draft doesn't claim

The consensus/outlier scoring is a simple, explainable first pass
(documented in `PROCESS.md`), not a claim about real threat-detection
quality. There are still no accounts and no incident severity beyond what
analysts assign it. What "good" means here is expected to keep sharpening
as the loop gets used.

## Sources

Framed against the brief's own small-scale precedents — software built for
one room, one afternoon, one specific group — rather than against enterprise
SOC dashboards, which assume a scale and a seriousness this app deliberately
doesn't have.
