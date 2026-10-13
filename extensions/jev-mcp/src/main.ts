#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { httpJevCall } from "./route.ts";
import { serve } from "./server.ts";
import { defaultDbPath, JevStore, type LegacyRow } from "./store.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    db: { type: "string" },
    "import-legacy": { type: "string" },
  },
});

const dbPath = values.db ?? defaultDbPath();
const store = new JevStore(dbPath);

if (values["import-legacy"] !== undefined) {
  const rows = JSON.parse(NodeFS.readFileSync(values["import-legacy"], "utf8")) as LegacyRow[];
  console.log(JSON.stringify({ dbPath, rows: rows.length, imported: store.importLegacy(rows) }));
  store.close();
} else {
  await serve({ store, call: httpJevCall() });
  store.close();
}
