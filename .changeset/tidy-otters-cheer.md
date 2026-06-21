---
---

feat: add Vercel Web Analytics custom events to the marketing site and docs. The web site now tracks `cta_click` (location + target), `connector_select` (engine), and `demo_tab` (mode); the docs site tracks `docs_outbound` (target + host). Events are cookieless and low-cardinality with no PII (ADR 0003). No package changes — both sites are private.
