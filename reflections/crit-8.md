# Crit 8

**What was the breakthrough that moved the work forward?**

Deciding what "small" actually meant for this app, rather than defaulting to
a generic multi-user dashboard. The idea started as a SOC tool, which
naturally pulls toward enterprise scale and polish. The breakthrough was
realizing the brief's small-scale framing could sharpen the concept instead
of fighting it: a handful of analysts in a crit room, watching consensus
form live, is more interesting than a "real" SOC dashboard would be at this
size. Once that was settled, the technical decisions got easier — a single
SQLite file and a plain WebSocket broadcast are obviously enough once you're
not pretending to serve a real security team.

**What did this work change about who I want to be as a software developer?**

I went into this defaulting to picking the biggest, most "production-grade"
stack I could justify. Working within the 256MB/one-machine/no-database
constraint pushed me the other way — `node:sqlite` and plain `http`/`ws`
turned out to be not just adequate but genuinely better fits than the
heavier defaults I'd have reached for otherwise. I want to be the kind of
developer who treats constraints as a design input rather than an obstacle
to engineer around, and who can justify "no, we don't need that" as
confidently as "yes, we do."

<!-- TODO: this is a first draft — read it over and put it in your own words
     before the cutoff; it should sound like you, not like your agent. -->
