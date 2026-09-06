---
"@uptimizr/dashboard": minor
---

Walked path panel: color-code the session trajectory by camera height (world Y) using the shared Ember heat ramp, with a legend showing the lowest and highest points on the route. Ramps, stairs, lifts, and multi-floor routes now read in the top-down plan view instead of looking like adjacent points on one floor (#92). Paths whose height varies by less than 0.25 m stay a single color and say so.
