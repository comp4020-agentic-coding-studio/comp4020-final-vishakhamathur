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

## What this draft doesn't claim

This is the crit-8 first draft: core loop only. The consensus/outlier
scoring is a simple, explainable first pass (documented in `PROCESS.md`), not
a claim about real threat-detection quality. No accounts, no incident
severity beyond what analysts assign it, no admin controls yet. What "good"
means here is expected to sharpen across crits 9 and 10 as the loop gets
used.

## Sources

Framed against the brief's own small-scale precedents — software built for
one room, one afternoon, one specific group — rather than against enterprise
SOC dashboards, which assume a scale and a seriousness this app deliberately
doesn't have.
