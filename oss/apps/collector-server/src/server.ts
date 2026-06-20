#!/usr/bin/env node
import { serve } from "./serve.js";

/**
 * Process entrypoint for the `uptimizr-collector` bin (kept for compatibility;
 * `uptimizr serve` is the preferred surface — ADR 0029). Runs the ingestion +
 * query API and fails fast if required configuration is missing.
 */
serve().catch((err) => {
  console.error(err);
  process.exit(1);
});
