---
---

fix(demo): wait for the service worker to control the page during "Prepare demo" so the dashboard's `/api/v1/*` calls are intercepted on first visit, instead of stalling at "Installing the in-browser collector…".
