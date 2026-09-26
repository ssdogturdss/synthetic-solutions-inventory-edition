import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

type StatusFile = Record<string, string>;
type CopyStatus = "fresh" | "stale" | "missing" | "unknown";
type RunStatus = "success" | "failure" | "unknown";
type CheckStatus = "fresh" | "stale" | "unknown";

export interface BackupHealthMetadata {
  overallStatus: "healthy" | "degraded" | "unknown";
  maxAgeHours: number;
  latestRun: {
    status: RunStatus;
    finishedAt: string | null;
    message: string | null;
  };
  localCopy: {
    status: CopyStatus;
    ageSeconds: number | null;
  };
  offsiteCopy: {
    status: CopyStatus;
    ageSeconds: number | null;
  };
  latestCheck: {
    status: CheckStatus;
    finishedAt: string | null;
    ageSeconds: number | null;
  };
  lastRestoreDrillAt: string | null;
  recoveryGuidance: string;
}

const MAX_STATUS_FILE_BYTES = 16 * 1024;
const DEFAULT_MAX_AGE_HOURS = 26;

function parseStatusFile(content: string): StatusFile | null {
  if (!content || content.includes("\uFFFD") || content.includes("\0")) return null;

  const status = Object.create(null) as StatusFile;
  for (const line of content.split(/\r?\n/)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) return null;

    const key = line.slice(0, separator);
    if (!/^[a-z_]+$/.test(key) || Object.hasOwn(status, key)) return null;
    status[key] = line.slice(separator + 1);
  }

  return Object.keys(status).length > 0 ? status : null;
}

function timestamp(value: string | undefined): string | null {
  if (!value || value.length > 64) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;

  const normalized = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const canonical = new Date(parsed).toISOString();
  return canonical === normalized ? canonical : null;
}

function isRunRecord(record: StatusFile): boolean {
  return (
    (record["status"] === "success" || record["status"] === "failure") &&
    timestamp(record["finished_at"]) !== null
  );
}

function isCheckRecord(record: StatusFile): boolean {
  if (
    (record["status"] !== "success" && record["status"] !== "failure") ||
    timestamp(record["finished_at"]) === null ||
    record["max_age_hours"] === undefined ||
    record["local_status"] === undefined ||
    record["offsite_status"] === undefined
  ) {
    return false;
  }

  if (positiveInteger(record["max_age_hours"], 0) === 0) {
    return false;
  }

  const localStatus = record["local_status"];
  const offsiteStatus = record["offsite_status"];
  const validCopyStatuses = ["fresh", "stale", "missing", "unknown"];
  if (!validCopyStatuses.includes(localStatus) || !validCopyStatuses.includes(offsiteStatus)) {
    return false;
  }

  const localAge = nonNegativeInteger(record["local_age_seconds"]);
  const offsiteAge = nonNegativeInteger(record["offsite_age_seconds"]);
  if (
    (record["local_age_seconds"] !== undefined && localAge === null) ||
    (record["offsite_age_seconds"] !== undefined && offsiteAge === null) ||
    (["fresh", "stale"].includes(localStatus) && localAge === null) ||
    (["fresh", "stale"].includes(offsiteStatus) && offsiteAge === null)
  ) {
    return false;
  }

  if (
    record["status"] === "success" &&
    (localStatus !== "fresh" ||
      offsiteStatus !== "fresh" ||
      localAge === null ||
      offsiteAge === null)
  ) {
    return false;
  }

  return true;
}

async function readStatusFile(
  filePath: string,
  isValidRecord: (record: StatusFile) => boolean,
): Promise<StatusFile | null> {
  let file;
  try {
    file = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }

  try {
    if (!(await file.stat()).isFile()) return null;

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_STATUS_FILE_BYTES) {
      const buffer = Buffer.alloc(
        Math.min(4096, MAX_STATUS_FILE_BYTES + 1 - totalBytes),
      );
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_STATUS_FILE_BYTES) return null;
      chunks.push(buffer.subarray(0, bytesRead));
    }

    const status = parseStatusFile(Buffer.concat(chunks, totalBytes).toString("utf8"));
    return status && isValidRecord(status) ? status : null;
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function ageSeconds(finishedAt: string | null, now: Date): number | null {
  if (!finishedAt) return null;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(finishedAt)) / 1000));
}

function copyStatus(value: string | undefined, fallback: CopyStatus): CopyStatus {
  if (value === "fresh" || value === "stale" || value === "missing" || value === "unknown") {
    return value;
  }
  return fallback;
}

function failureGuidance(unit: "inventory-backup.service" | "inventory-backup-check.service"): string {
  return `ACTION REQUIRED: ${unit} failed. Check 'journalctl -u ${unit} -n 100 --no-pager'; restore service health before relying on inventory data.`;
}

function metadataRecoveryGuidance(): string {
  return "ACTION REQUIRED: Backup health metadata is missing, unreadable, malformed, or stale. Check the backup host's status files and run 'systemctl status inventory-backup.service inventory-backup-check.service'; restore service health before relying on inventory data.";
}

export async function getBackupHealth(now = new Date()): Promise<BackupHealthMetadata> {
  const statusDir = process.env["BACKUP_STATUS_DIR"] ?? "/var/lib/inventory-backups";
  const [runRecord, checkRecord, restoreDrillRecord] = await Promise.all([
    readStatusFile(path.join(statusDir, "last-run"), isRunRecord),
    readStatusFile(path.join(statusDir, "last-check"), isCheckRecord),
    readStatusFile(path.join(statusDir, "last-restore-drill"), (record) =>
      record["status"] === "success" &&
      record["verified_at"] !== undefined &&
      timestamp(record["verified_at"]) !== null),
  ]);

  const maxAgeHours = positiveInteger(
    checkRecord?.["max_age_hours"] ?? process.env["MAX_BACKUP_AGE_HOURS"],
    DEFAULT_MAX_AGE_HOURS,
  );
  const runFinishedAt = timestamp(runRecord?.["finished_at"]);
  const checkFinishedAt = timestamp(checkRecord?.["finished_at"]);
  const lastRestoreDrillAt = restoreDrillRecord?.["status"] === "success"
    ? timestamp(restoreDrillRecord["verified_at"])
    : null;
  const checkAgeSeconds = ageSeconds(checkFinishedAt, now);
  const maxAgeSeconds = maxAgeHours * 60 * 60;
  const checkIsFresh = checkAgeSeconds !== null && checkAgeSeconds <= maxAgeSeconds;
  const checkStatus: CheckStatus = !checkRecord
    ? "unknown"
    : checkRecord["status"] === "success" && checkIsFresh
      ? "fresh"
      : "stale";

  const recordedLocalStatus = copyStatus(
    checkRecord?.["local_status"],
    checkRecord?.["status"] === "success" ? "fresh" : "unknown",
  );
  const recordedOffsiteStatus = copyStatus(
    checkRecord?.["offsite_status"],
    checkRecord?.["status"] === "success" ? "fresh" : "unknown",
  );
  // A copy cannot remain actionable as "fresh" after the watchdog evidence
  // itself has gone stale. Keep missing/stale/failure details intact while
  // preventing the admin UI from implying that old evidence is current.
  const localCopyStatus = !checkIsFresh && recordedLocalStatus === "fresh"
    ? "stale"
    : recordedLocalStatus;
  const offsiteCopyStatus = !checkIsFresh && recordedOffsiteStatus === "fresh"
    ? "stale"
    : recordedOffsiteStatus;
  const localCopy = {
    status: localCopyStatus,
    ageSeconds: nonNegativeInteger(checkRecord?.["local_age_seconds"]),
  };
  const offsiteCopy = {
    status: offsiteCopyStatus,
    ageSeconds: nonNegativeInteger(checkRecord?.["offsite_age_seconds"]),
  };
  const latestRun: BackupHealthMetadata["latestRun"] = {
    status: runRecord?.["status"] === "success" || runRecord?.["status"] === "failure"
      ? runRecord["status"]
      : "unknown",
    finishedAt: runFinishedAt,
    message: runRecord?.["status"] === "success"
      ? "backup completed and freshness was verified"
      : runRecord?.["status"] === "failure"
        ? "Backup failed; inspect the systemd journal."
        : null,
  };

  const runFailed = latestRun.status === "failure";
  const copiesHealthy = localCopy.status === "fresh" && offsiteCopy.status === "fresh";
  const healthKnown = runRecord !== null || checkRecord !== null;
  const isHealthy = latestRun.status === "success" && checkStatus === "fresh" && copiesHealthy;
  const overallStatus = isHealthy ? "healthy" : healthKnown ? "degraded" : "unknown";

  let recoveryGuidance = "Backups are fresh and verified. Continue monitoring the scheduled backup and freshness services.";
  if (runFailed) {
    recoveryGuidance = failureGuidance("inventory-backup.service");
  } else if (checkRecord?.["status"] === "failure") {
    recoveryGuidance = failureGuidance("inventory-backup-check.service");
  } else if (!isHealthy) {
    recoveryGuidance = metadataRecoveryGuidance();
  }

  return {
    overallStatus,
    maxAgeHours,
    latestRun,
    localCopy,
    offsiteCopy,
    latestCheck: {
      status: checkStatus,
      finishedAt: checkFinishedAt,
      ageSeconds: checkAgeSeconds,
    },
    lastRestoreDrillAt,
    recoveryGuidance,
  };
}