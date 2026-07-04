---
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/react": minor
---

feat(dashboard,db): 360° view-coverage gauge per session (#146)

Add a derived per-session **view-coverage** metric: bin each session's
`camera_sample` directions into the same azimuth/elevation grid as the
view-direction dome, and report the fraction of cells visited as a 0–100%
coverage score. Sessions are aggregated into a histogram of 25%-wide coverage
bands (0–25 / 25–50 / 50–75 / 75–100%) — "how many visitors never rotated the
product to see the back".

- `@uptimizr/db`: new `buildViewCoverageHistogram` query builder + `ViewCoverageHistogramRow`.
- `@uptimizr/collector-server`: new `GET /api/v1/coverage/view-histogram` read endpoint.
- `@uptimizr/react`: new `viewCoverageHistogram` API client method and the **View coverage**
  dashboard panel.

No schema change — entirely derived from the existing `camera_sample` stream.
