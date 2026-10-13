import { z } from "zod";
import { readFileSync } from "node:fs";
export function config(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z
    .object({
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      BIND: z.enum(["127.0.0.1", "0.0.0.0", "::1"]).default("127.0.0.1"),
      TLS_CERT: z.string().optional(),
      TLS_KEY: z.string().optional(),
      PUBLIC_ORIGIN: z.string().url().optional(),
      DATA_DIR: z.string().default("data"),
      LOG_LEVEL: z
        .enum(["debug", "info", "warn", "error", "silent"])
        .default("info"),
      PROXY_ADDRESS: z.union([z.ipv4(), z.ipv6()]).optional(),
      TRUST_PROXY: z.enum(["true", "false"]).default("false"),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
  if (Boolean(parsed.TLS_CERT) !== Boolean(parsed.TLS_KEY))
    throw new Error("TLS_CERT and TLS_KEY must both be supplied");
  if (
    parsed.TRUST_PROXY === "true" &&
    !parsed.PUBLIC_ORIGIN?.startsWith("https://")
  )
    throw new Error("Trusted proxy requires HTTPS PUBLIC_ORIGIN");
  return {
    ...parsed,
    https: parsed.TLS_CERT
      ? {
          cert: readFileSync(parsed.TLS_CERT),
          key: readFileSync(parsed.TLS_KEY!),
        }
      : undefined,
  };
}
