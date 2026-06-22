---
"@uptimizr/collector-server": patch
---

fix(collector): allow credentials in the CORS preflight so cross-origin ingestion works. The SDK ingests via `navigator.sendBeacon`, which always sends in credentials mode `include`; without `Access-Control-Allow-Credentials: true` the browser dropped the beacon, breaking the common self-host layout where the app and collector run on different origins.
