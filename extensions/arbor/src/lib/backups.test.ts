import { describe, expect, it } from "vitest";
import {
  describeScheduledOutcome,
  parseScheduledRun,
  trimBackups,
  type BackupRecord,
  type BackupRepository,
  type ScheduledRun,
} from "./backups";
import { ARBOR_FORMAT, ARBOR_FORMAT_VERSION } from "./io/arbor-json";

function repositoryWith(timestamps: number[]) {
  const records = new Map<number, BackupRecord>();
  for (const ts of timestamps) {
    records.set(ts, {
      ts,
      nodeCount: 1,
      data: {
        format: ARBOR_FORMAT,
        version: ARBOR_FORMAT_VERSION,
        exportedAt: ts,
        nodeCount: 1,
        nodes: [],
      },
    });
  }
  const repository: BackupRepository = {
    async list() {
      return [...records.values()]
        .map((r) => ({ ts: r.ts, nodeCount: r.nodeCount }))
        .sort((a, b) => b.ts - a.ts);
    },
    async get(ts) {
      return records.get(ts);
    },
    async put(record) {
      records.set(record.ts, record);
    },
    async delete(ts) {
      records.delete(ts);
    },
  };
  return { repository, records };
}

describe("trimBackups", () => {
  it("keeps the newest N and always at least one", async () => {
    const { repository, records } = repositoryWith([10, 30, 20]);
    expect(await trimBackups(repository, 2)).toBe(1);
    expect([...records.keys()].sort()).toEqual([20, 30]);
    expect(await trimBackups(repository, 0)).toBe(1);
    expect([...records.keys()]).toEqual([30]);
  });
});

describe("describeScheduledOutcome", () => {
  it("says what the tick did in one line", () => {
    expect(describeScheduledOutcome({ kind: "written", nodeCount: 112 })).toBe(
      "written (112 nodes)",
    );
    expect(describeScheduledOutcome({ kind: "skipped", reason: "licence-unavailable" })).toBe(
      "skipped: licence check unavailable",
    );
    expect(describeScheduledOutcome({ kind: "skipped", reason: "not-pro" })).toBe(
      "skipped: not Pro",
    );
    expect(describeScheduledOutcome({ kind: "skipped", reason: "disabled" })).toBe(
      "skipped: schedule off",
    );
    expect(describeScheduledOutcome({ kind: "failed", error: "quota" })).toBe("failed: quota");
  });
});

describe("parseScheduledRun", () => {
  it("round-trips every outcome", () => {
    const runs: ScheduledRun[] = [
      { at: 1, outcome: { kind: "written", nodeCount: 3 } },
      { at: 2, outcome: { kind: "skipped", reason: "not-pro" } },
      { at: 3, outcome: { kind: "failed", error: "boom" } },
    ];
    for (const run of runs) expect(parseScheduledRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  it("reads anything malformed as no run recorded", () => {
    expect(parseScheduledRun(undefined)).toBeUndefined();
    expect(parseScheduledRun("written")).toBeUndefined();
    expect(
      parseScheduledRun({ at: "1", outcome: { kind: "written", nodeCount: 1 } }),
    ).toBeUndefined();
    expect(
      parseScheduledRun({ at: 1, outcome: { kind: "skipped", reason: "tired" } }),
    ).toBeUndefined();
    expect(parseScheduledRun({ at: 1, outcome: { kind: "written" } })).toBeUndefined();
    expect(parseScheduledRun({ at: 1 })).toBeUndefined();
  });
});
