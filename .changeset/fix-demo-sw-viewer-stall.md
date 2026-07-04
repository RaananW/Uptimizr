---
---

fix(demo): stop the service worker from stalling the viewer on aborted fetches

The stale-while-revalidate handler could resolve `respondWith` with `undefined`
when a request missed the cache and its `fetch` was aborted mid-navigation (e.g.
switching to a session view), throwing "Failed to convert value to 'Response'"
and failing the resource load. The handler now always resolves to a `Response`.
