---
---

Make the anomalies bounded-cost test warm up once and judge the best of three timed runs, with a 5 s bound, so a loaded CI runner (which measured ~2.1 s per call) cannot fail it while a quadratic regression still does. Test only; no published package changes.
