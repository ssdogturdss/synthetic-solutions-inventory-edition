import { eq } from "drizzle-orm";

import { db, inventorySessionsTable, pool } from "@workspace/db";

const sessionId = Number(process.argv[2]);
const STALE_DAYS = 21;

async function main() {
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    throw new Error("Usage: backdate-e2e-session.ts <positive session id>");
  }

  const staleAt = new Date(Date.now() - STALE_DAYS * 86_400_000);
  const [updated] = await db
    .update(inventorySessionsTable)
    .set({ startedAt: staleAt, finalizedAt: staleAt })
    .where(eq(inventorySessionsTable.id, sessionId))
    .returning({
      id: inventorySessionsTable.id,
      finalizedAt: inventorySessionsTable.finalizedAt,
    });

  if (!updated) {
    throw new Error(`Inventory session ${sessionId} was not found`);
  }

  console.log(
    `Backdated E2E session ${updated.id} to ${updated.finalizedAt?.toISOString()}`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
