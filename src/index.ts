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
});
