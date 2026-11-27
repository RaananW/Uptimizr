---
"@uptimizr/react": minor
---

The session replay canvas now publishes what it has drawn, for tests and embedders that can't
read WebGL: `data-click-rays-shown` counts the click rays that have started to play, and
`data-click-pulses-shown` how many separate pulses they made. The live replay's de-duplication
and click timing move into a rendering-free module with unit tests over whole event streams; the
behaviour is unchanged.
