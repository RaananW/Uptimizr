---
"@uptimizr/demo": patch
---

Stop the demo storing a batch twice when its page is busy. The service worker hands each collector
request to the demo page and answered `504` if the page had not replied within 15 s, though the
page still applied the batch when it got to it. The SDK retried the `504`, and the batch was
stored twice, clicks included. A collect request that times out is now answered `202 Accepted`,
since the page already holds the batch; reads still get `504`.
