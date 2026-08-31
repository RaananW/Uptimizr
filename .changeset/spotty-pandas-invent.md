---
"@uptimizr/collector-server": minor
---

`COLLECTOR_TRUST_PROXY` no longer accepts a bare hop count and now fails at startup with an explanatory error if one is set.

Fastify 5.12.1 disabled numeric hop-count trust: a hop count cannot validate the immediate peer, so a client talking to the collector directly could spoof `X-Forwarded-*` by supplying enough hops. Fastify now fails closed on a number and silently ignores the forwarded headers — which would quietly bucket the cookieless visitor hash and the rate limiter on the proxy's IP instead of the client's.

**Action required** if you set a hop count (e.g. `COLLECTOR_TRUST_PROXY=1`): name the trusted proxy instead — a single IP, a CIDR, or a comma-separated list (`COLLECTOR_TRUST_PROXY=10.0.0.0/8`), or `true` when the collector is not directly reachable. Deployments that leave it unset, or already set `true`/an IP list, are unaffected.
