---
"@uptimizr/react": patch
"@uptimizr/dashboard": patch
---

Make click rays visible in first-person and live replays. The session replay now draws interaction rays, hit markers and the hit glow on top of the camera's view cone and scales the hit markers to the scene, so a pointer-lock click, which fires straight down the view direction, is no longer hidden inside the cone. While following a live session, a click's ray plays from when it arrives: events reach the dashboard in batches, and a batched click used to arrive after its fade window had already passed and was never drawn.
