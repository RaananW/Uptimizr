---
"@uptimizr/db": patch
"@uptimizr/metrics": patch
---

Type `TrajectoryPointRow.ts` and `AggregateTrajectoryPointRow.ts` as `number`: the queries have always returned epoch milliseconds, on every engine.
