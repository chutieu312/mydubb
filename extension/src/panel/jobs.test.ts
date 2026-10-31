import { describe, expect, it, vi } from "vitest";

import type { Job } from "../../../frontend/src/api/types";
import { MyDubbError } from "./api";
import { isJobRecord, pollJob, recordBelongs, type JobRecord } from "./jobs";

const job = (status: string) => ({ id: "j1", status }) as Job;

function harness(answers: (Job | Error)[], options: { maxDurationMs?: number } = {}) {
  let clock = 0;
  const delays: number[] = [];
  const controller = new AbortController();
  const getJob = vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  });
  const updates: string[] = [];
  const run = pollJob({
    getJob,
    onUpdate: (j) => updates.push(j.status),
    signal: controller.signal,
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...options,
  });
  return { run, getJob, delays, updates, controller };
}

describe("pollJob", () => {
  it("backs off by 1.5x up to 10 s and stops at completed", async () => {
    const statuses = ["queued", "translating", "synthesizing", "processing", "processing", "processing", "processing"];
    const h = harness([...statuses.map(job), job("completed")]);
    expect(await h.run).toEqual({ kind: "terminal", job: job("completed") });
    expect(h.delays).toEqual([1000, 1500, 2250, 3375, 5063, 7595, 10000]);
    expect(h.updates.at(-1)).toBe("completed");
  });

  it("stops at failed", async () => {
    expect((await harness([job("queued"), job("failed")]).run).kind).toBe("terminal");
  });

  it("stops when the token is refused or the job is gone", async () => {
    expect((await harness([new MyDubbError(401, "not_authenticated", "x")]).run).kind).toBe("unauthenticated");
    expect((await harness([new MyDubbError(404, "job_not_found", "x")]).run).kind).toBe("gone");
  });

  it("gives up after five failures in a row, but not after fewer", async () => {
    const net = () => new MyDubbError(0, "network_error", "x");
    const recovered = harness([net(), net(), net(), net(), job("completed")]);
    expect((await recovered.run).kind).toBe("terminal");
    const broken = harness([net(), net(), net(), net(), net()]);
    expect(await broken.run).toMatchObject({ kind: "gave-up", reason: "errors" });
    expect(broken.getJob).toHaveBeenCalledTimes(5);
  });

  it("has a time limit", async () => {
    const h = harness(
      Array.from({ length: 100 }, () => job("processing")),
      { maxDurationMs: 20_000 },
    );
    expect(await h.run).toMatchObject({ kind: "gave-up", reason: "time" });
    expect(h.delays.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20_000);
  });

  it("stops quietly once aborted", async () => {
    const h = harness([job("queued"), job("queued")]);
    h.controller.abort();
    expect(await h.run).toEqual({ kind: "aborted" });
    expect(h.updates).toEqual([]);
  });
});

describe("job records", () => {
  const record: JobRecord = {
    operationId: "op",
    userId: "u1",
    connectionId: "c1",
    lessonKey: "course/1",
    state: "created",
    jobId: "j1",
    sentAt: 1,
    choices: {
      languageLabel: "Vietnamese",
      voiceLabel: "Andrew",
      speed: 1,
      timed: false,
      firstStart: "00:00:01",
      lastStart: "00:00:09",
    },
  };
  const account = { userId: "u1", connectionId: "c1" };

  it("belong to one connection of one account and one lecture", () => {
    expect(recordBelongs(record, account, "course/1")).toBe(true);
    expect(recordBelongs(record, account, undefined)).toBe(true);
    expect(recordBelongs(record, account, "course/2")).toBe(false);
    expect(recordBelongs(record, account, null)).toBe(false);
    expect(recordBelongs(record, { userId: "u2", connectionId: "c1" }, "course/1")).toBe(false);
    expect(recordBelongs(record, { userId: "u1", connectionId: "c2" }, "course/1")).toBe(false);
    expect(recordBelongs(record, null, "course/1")).toBe(false);
  });

  it("are validated", () => {
    expect(isJobRecord(record)).toBe(true);
    expect(isJobRecord({ ...record, state: "created", jobId: null })).toBe(false);
    expect(isJobRecord({ ...record, state: "sending", jobId: null })).toBe(true);
    expect(isJobRecord({ ...record, choices: undefined })).toBe(false);
  });
});
