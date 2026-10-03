import { resolve } from "node:path";

import type { Config } from "../config.ts";
import { openFileStore } from "./file.ts";
import type { Store } from "./types.ts";

export async function openStore(config: Config): Promise<Store> {
  if (config.databaseUrl) {
    const { openPostgres } = await import("./postgres.ts");
    return openPostgres(config.databaseUrl);
  }
  return openFileStore(resolve("data/store.json"));
}
