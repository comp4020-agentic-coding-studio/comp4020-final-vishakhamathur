# Cyber Threat Consensus Board

A live, in-person Security Operations Center (SOC) social-deduction game.
The server invents plausible security incidents — a login spike, an odd
outbound transfer — and connected analysts vote on how severe and likely
each one is. One connected analyst is secretly the **Insider Threat**,
quietly dragging the room's votes off target; everyone else's job is to
catch them before the shift ends.

## Who this is for

A small, synchronous room: four or five people in a crit room, friends on
the same link at once. Built to be narrated live, not used solo.

## What "good" means here

1. **One shift, start to finish, with a resolution everyone can see.** A
   lobby waits for enough people; `Start Shift` kicks off three timed
   threats back to back; a Security Audit vote ends the round with a clear
   winner.
2. **The Insider Threat's only move is social.** Nothing they submit is
   mechanically different from any other analyst — same sliders, same vote
   shape. The only way to catch them is watching how people vote and
   talking about it out loud.
3. **Authorization is server-enforced, not UI-enforced, and narratable.**
   One vote per session per threat, one audit vote per round, a real quorum
   to start a shift — all checked against the server's own state, never a
   client's claim — and every one of those events writes a one-line,
   read-aloud log entry a presenter can narrate the demo from.
4. **Identity and the log survive a restart; a round deliberately doesn't.**
   Your codename and every past vote/ejection stay in `/data`'s SQLite file
   across restarts and redeploys — close the tab and come back, you're the
   same analyst. The in-progress shift resets on restart, on purpose: it's
   one room's live, synchronous moment, not a record meant to resume later.

## Playing a shift

Open the app and you're assigned a codename (e.g. "Agent Crimson Hawk-7")
— no sign-up. Once three analysts are connected, anyone can click
**Start Shift**. The server secretly assigns one connected analyst as the
**Insider Threat**; everyone else is an **Analyst**, and each person sees
only their own role.

Three threats run one after another with a 20-second countdown, each with
a plain-English hint beside the jargon so judging doesn't need a security
background. Drag **Severity** and **Likelihood** (1–10) and **Cast vote**
— one vote per analyst per threat, server-enforced, locking in once cast.
Votes land on the shared risk matrix live for everyone watching.

Once all three resolve, a 30-second **Security Audit** begins: the matrix
is replaced by a list of connected codenames. Click one to vote to
**Revoke** them. The top vote-getter when the clock hits zero is ejected —
their screen locks under a full-screen `[CREDENTIALS REVOKED]` banner —
and the room learns whether the ejected analyst really was the Insider.

Eject the real Insider → **Analysts win**. Eject an innocent Analyst, or
reach no majority → **Insider wins**. The round role only changes what's
shown, never what the server accepts; every vote, denial, audit vote, and
ejection writes both a durable `action_log` row and a human-readable
terminal line — see `PROCESS.md` for how each check works and the full log
tag list.

## What this draft doesn't claim

Each threat's true/false-positive call is a simple first pass — flavor
here, since the real objective is finding the Insider Threat. No accounts;
identity is just a signed cookie.

## Sources

Framed against the brief's own small-scale precedents — software for one
room, one afternoon, one group — rather than enterprise SOC dashboards or
commercial social-deduction games, neither of which this tries to be.
