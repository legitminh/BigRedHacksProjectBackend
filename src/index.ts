import { resolve } from "node:path";

import { PendingLogins } from "./auth/pending.ts";
import { loadConfig, loadEnvFile } from "./config.ts";
import { createApp } from "./server.ts";
import { openStore } from "./store/index.ts";

loadEnvFile();
const config = loadConfig();
const store = await openStore(config);
const pending = new PendingLogins(resolve("data/pending-google-logins.json"));
const server = createApp({ config, store, pending });

server.listen(config.port, config.bindHost, () => {
  console.log(
    `Waypoint API listening on ${config.bindHost}:${config.port} → ${config.publicBaseUrl} (${store.kind} storage)`,
  );
  // Behind nginx/Caddy every client looks like 127.0.0.1 unless TRUST_PROXY=1.
  // Only enable behind a proxy you control (clients can otherwise spoof X-Forwarded-For).
  const publicHttps = config.publicBaseUrl.toLowerCase().startsWith("https://");
  const loopbackBind =
    config.bindHost === "127.0.0.1" ||
    config.bindHost === "localhost" ||
    config.bindHost === "::1";
  if (publicHttps && loopbackBind && !config.trustProxy) {
    console.warn(
      "TRUST_PROXY is off while PUBLIC_BASE_URL is https and BIND_HOST is loopback — " +
        "all clients share one rate-limit IP bucket. Set TRUST_PROXY=1 behind nginx/Caddy " +
        "(and only then; never on a public bind without a trusted proxy).",
    );
  }
});
