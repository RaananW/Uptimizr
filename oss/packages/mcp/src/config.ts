import { z } from "zod";

/**
 * Runtime configuration for the MCP server. The server only ever talks to the
 * consumer's **own** collector, authenticated with the consumer's project API
 * key — nothing is sent to any third party (ADR 0003 / ADR 0017).
 */
export interface McpConfig {
  /** Base URL of the consumer's Uptimizr collector (e.g. https://collect.example.com). */
  collectorUrl: string;
  /** Project API key (`x-api-key`) used for read requests. */
  apiKey: string;
}

const envSchema = z.object({
  UPTIMIZR_COLLECTOR_URL: z.string().url("UPTIMIZR_COLLECTOR_URL must be a valid URL"),
  UPTIMIZR_API_KEY: z.string().min(1, "UPTIMIZR_API_KEY must not be empty"),
});

/**
 * Read and validate configuration from the environment. Throws a clear error if
 * the collector URL or API key is missing or malformed.
 */
export function readMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid Uptimizr MCP configuration: ${issues}`);
  }
  return {
    collectorUrl: parsed.data.UPTIMIZR_COLLECTOR_URL,
    apiKey: parsed.data.UPTIMIZR_API_KEY,
  };
}
