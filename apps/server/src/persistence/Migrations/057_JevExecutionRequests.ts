import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A digest of the original request, never the Jev key or request content.
  // Recorded before execution so a lost reply can be replayed after restart.
  yield* sql`CREATE TABLE jev_execution_requests (
    command_id TEXT PRIMARY KEY NOT NULL,
    request_digest TEXT NOT NULL
  )`;
});
