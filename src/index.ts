import { loadConfig, loadEnvFile } from "./config.ts";
import { createApp } from "./server.ts";
import { openStore } from "./store/index.ts";

loadEnvFile();
const config = loadConfig();
const store = await openStore(config);
const server = createApp({ config, store });

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Waypoint API listening on ${config.publicBaseUrl} (${store.kind} storage)`);
});
