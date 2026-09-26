import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

process.env["SESSION_SECRET"] = "backup-health-api-test-session-secret";

const [{ default: backupsRouter }, { signToken }] = await Promise.all([
  import("../routes/backups"),
  import("./auth"),
]);

const app = express();
app.use(backupsRouter);

const server = createServer(app);
let serverUrl: string;
let testRoot: string;

const adminToken = signToken({ userId: 1, role: "admin", storeId: null });
const storeUserToken = signToken({ userId: 2, role: "store_user", storeId: 1 });
const expectedTopLevelKeys = [
  "overallStatus",
  "maxAgeHours",
  "latestRun",
  "localCopy",
  "offsiteCopy",
  "latestCheck",
  "lastRestoreDrillAt",
  "recoveryGuidance",
].sort();

async function writeRecord(
  dir: string,
  name: string,
  contents: string,
): Promise<void> {
  await writeFile(path.join(dir, name), contents, "utf8");
}

async function createStatusDir(name: string): Promise<string> {
  const dir = path.join(testRoot, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function requestHealth(token?: string): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${serverUrl}/backup/health`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    text,
  };
}

function assertMetadataOnly(body: any): void {
  assert.deepEqual(Object.keys(body).sort(), expectedTopLevelKeys);
  assert.deepEqual(Object.keys(body.latestRun).sort(), ["finishedAt", "message", "status"]);
  assert.deepEqual(Object.keys(body.localCopy).sort(), ["ageSeconds", "status"]);
  assert.deepEqual(Object.keys(body.offsiteCopy).sort(), ["ageSeconds", "status"]);
  assert.deepEqual(Object.keys(body.latestCheck).sort(), ["ageSeconds", "finishedAt", "status"]);
  assert.equal(typeof body.recoveryGuidance, "string");
}

function runRecord(status = "success", message = "safe generated message"): string {
  const finishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return [
    `status=${status}`,
    `finished_at=${finishedAt}`,
    `message=${message}`,
    "",
  ].join("\n");
}

function checkRecord(status = "success"): string {
  const finishedAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  return [
    `status=${status}`,
    `finished_at=${finishedAt}`,
    "message=local and off-server backup freshness verified",
    "max_age_hours=26",
    "local_status=fresh",
    "local_age_seconds=3600",
    "offsite_status=fresh",
    "offsite_age_seconds=3600",
    "",
  ].join("\n");
}

async function assertUnknownWithGuidance(body: any): Promise<void> {
  assertMetadataOnly(body);
  assert.equal(body.overallStatus, "unknown");
  assert.equal(body.latestRun.status, "unknown");
  assert.equal(body.latestRun.finishedAt, null);
  assert.equal(body.latestRun.message, null);
  assert.equal(body.localCopy.status, "unknown");
  assert.equal(body.offsiteCopy.status, "unknown");
  assert.equal(body.latestCheck.status, "unknown");
  assert.match(body.recoveryGuidance, /ACTION REQUIRED/);
  assert.match(body.recoveryGuidance, /inventory-backup-check\.service/);
}

async function setStatusDir(dir: string): Promise<void> {
  process.env["BACKUP_STATUS_DIR"] = dir;
}

async function makeUnreadableStatus(
  dir: string,
  name: "last-run" | "last-check",
  contents: string,
): Promise<void> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0);

  // Root can bypass file permission bits, so use a directory at the status
  // path to reliably exercise the same unreadable-file fallback in that case.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await rm(filePath);
    await mkdir(filePath);
  }
}

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
  const address = target.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(target: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "backup-health-api-test-"));
  const oldStatusDir = process.env["BACKUP_STATUS_DIR"];
  serverUrl = await listen(server);

  try {
    const unauthenticated = await requestHealth();
    assert.equal(unauthenticated.status, 401);

    const nonAdmin = await requestHealth(storeUserToken);
    assert.equal(nonAdmin.status, 403);
    assert.deepEqual(nonAdmin.body, { error: "Admin access required" });

    const missingDir = path.join(testRoot, "missing");
    await setStatusDir(missingDir);
    const missing = await requestHealth(adminToken);
    assert.equal(missing.status, 200);
    await assertUnknownWithGuidance(missing.body);

    const unreadableRunDir = await createStatusDir("unreadable-run");
    await makeUnreadableStatus(unreadableRunDir, "last-run", runRecord());
    await setStatusDir(unreadableRunDir);
    const unreadableRun = await requestHealth(adminToken);
    assert.equal(unreadableRun.status, 200);
    await assertUnknownWithGuidance(unreadableRun.body);

    const unreadableCheckDir = await createStatusDir("unreadable-check");
    await makeUnreadableStatus(unreadableCheckDir, "last-check", checkRecord());
    await setStatusDir(unreadableCheckDir);
    const unreadableCheck = await requestHealth(adminToken);
    assert.equal(unreadableCheck.status, 200);
    await assertUnknownWithGuidance(unreadableCheck.body);

    const malformedRunDir = await createStatusDir("malformed-run");
    await writeRecord(
      malformedRunDir,
      "last-run",
      "status=success\nfinished_at=not-a-timestamp\nmessage=PRIVATE_RUN_CONTENT\n",
    );
    await setStatusDir(malformedRunDir);
    const malformedRun = await requestHealth(adminToken);
    assert.equal(malformedRun.status, 200);
    await assertUnknownWithGuidance(malformedRun.body);
    assert.doesNotMatch(malformedRun.text, /PRIVATE_RUN_CONTENT/);

    const malformedCheckDir = await createStatusDir("malformed-check");
    await writeRecord(malformedCheckDir, "last-run", runRecord());
    await writeRecord(
      malformedCheckDir,
      "last-check",
      "status=success\nfinished_at=2026-02-30T10:30:00Z\nmessage=PRIVATE_CHECK_CONTENT\n",
    );
    await setStatusDir(malformedCheckDir);
    const malformedCheck = await requestHealth(adminToken);
    assert.equal(malformedCheck.status, 200);
    assertMetadataOnly(malformedCheck.body);
    assert.equal(malformedCheck.body.overallStatus, "degraded");
    assert.equal(malformedCheck.body.latestCheck.status, "unknown");
    assert.match(malformedCheck.body.recoveryGuidance, /ACTION REQUIRED/);
    assert.doesNotMatch(malformedCheck.text, /PRIVATE_CHECK_CONTENT/);

    const incompleteCheckDir = await createStatusDir("incomplete-check");
    await writeRecord(incompleteCheckDir, "last-run", runRecord());
    await writeRecord(
      incompleteCheckDir,
      "last-check",
      "status=success\nfinished_at=2026-09-24T10:30:00Z\nmax_age_hours=26\n",
    );
    await setStatusDir(incompleteCheckDir);
    const incompleteCheck = await requestHealth(adminToken);
    assert.equal(incompleteCheck.status, 200);
    assertMetadataOnly(incompleteCheck.body);
    assert.equal(incompleteCheck.body.overallStatus, "degraded");
    assert.equal(incompleteCheck.body.latestCheck.status, "unknown");
    assert.equal(incompleteCheck.body.localCopy.status, "unknown");
    assert.equal(incompleteCheck.body.offsiteCopy.status, "unknown");

    const oversizedRunDir = await createStatusDir("oversized-run");
    await writeRecord(
      oversizedRunDir,
      "last-run",
      `${runRecord()}PRIVATE_RUN_FILE_CONTENT${"x".repeat(20 * 1024)}`,
    );
    await setStatusDir(oversizedRunDir);
    const oversizedRun = await requestHealth(adminToken);
    assert.equal(oversizedRun.status, 200);
    await assertUnknownWithGuidance(oversizedRun.body);
    assert.doesNotMatch(oversizedRun.text, /PRIVATE_RUN_FILE_CONTENT/);

    const oversizedCheckDir = await createStatusDir("oversized-check");
    await writeRecord(oversizedCheckDir, "last-check", `${checkRecord()}PRIVATE_CHECK_FILE_CONTENT${"x".repeat(20 * 1024)}`);
    await setStatusDir(oversizedCheckDir);
    const oversizedCheck = await requestHealth(adminToken);
    assert.equal(oversizedCheck.status, 200);
    await assertUnknownWithGuidance(oversizedCheck.body);
    assert.doesNotMatch(oversizedCheck.text, /PRIVATE_CHECK_FILE_CONTENT/);

    const sensitiveMessageDir = await createStatusDir("sensitive-message");
    await writeRecord(sensitiveMessageDir, "last-run", runRecord("success", "SESSION_SECRET=PRIVATE_CREDENTIAL"));
    await writeRecord(sensitiveMessageDir, "last-check", checkRecord());
    await setStatusDir(sensitiveMessageDir);
    const sensitiveMessage = await requestHealth(adminToken);
    assert.equal(sensitiveMessage.status, 200);
    assertMetadataOnly(sensitiveMessage.body);
    assert.equal(sensitiveMessage.body.overallStatus, "healthy");
    assert.equal(sensitiveMessage.body.latestRun.message, "backup completed and freshness was verified");
    assert.doesNotMatch(sensitiveMessage.text, /PRIVATE_CREDENTIAL|SESSION_SECRET/);
  } finally {
    await close(server);
    if (oldStatusDir === undefined) delete process.env["BACKUP_STATUS_DIR"];
    else process.env["BACKUP_STATUS_DIR"] = oldStatusDir;
    await rm(testRoot, { recursive: true, force: true });
  }

  console.log("backup health API cases passed: authorization, missing, unreadable, malformed, oversized, metadata-only");
}

await main();