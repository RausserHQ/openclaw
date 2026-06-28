import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { runCronCommandJob } from "./command-runner.js";
import type { CronJob } from "./types.js";

function makeCommandJob(payload: Extract<CronJob["payload"], { kind: "command" }>): CronJob {
  const now = Date.now();
  return {
    id: "command-job",
    name: "Command job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
  };
}

describe("runCronCommandJob", () => {
  it("runs command argv and returns stdout as the deliverable summary", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('hello from cron')"],
        timeoutSeconds: 5,
      }),
      nowMs: () => 123,
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("hello from cron");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 123,
      source: "exec",
      severity: "info",
      exitCode: 0,
    });
  });

  it("uses deterministic scheduled-report envelope summary and details", async () => {
    const envelope = {
      summary:
        "LAX → YYZ daily flight check\nLowest: $3,679 total / $613 pp — Dec 20 → Dec 26 — 1 stop\nDetails in thread.",
      details: "browser/source info\nfull search parameters\nall best options",
    };
    const result = await runCronCommandJob({
      job: {
        ...makeCommandJob({
          kind: "command",
          argv: [
            process.execPath,
            "-e",
            `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))})`,
          ],
          timeoutSeconds: 5,
        }),
        delivery: {
          mode: "announce",
          channel: "slack",
          to: "COPENCLAW",
          presentation: { mode: "threaded_report" },
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe(envelope.summary);
    expect(result.reportDetails).toBe(envelope.details);
    expect(result.reportEnvelopeError).toBeUndefined();
  });

  it("keeps invalid scheduled-report envelopes debuggable without agent summarization", async () => {
    const badEnvelope = { summary: "compact only" };
    const result = await runCronCommandJob({
      job: {
        ...makeCommandJob({
          kind: "command",
          argv: [
            process.execPath,
            "-e",
            `process.stdout.write(${JSON.stringify(JSON.stringify(badEnvelope))})`,
          ],
          timeoutSeconds: 5,
        }),
        delivery: {
          mode: "announce",
          channel: "slack",
          to: "COPENCLAW",
          presentation: { mode: "threaded_report" },
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe(JSON.stringify(badEnvelope));
    expect(result.reportDetails).toBe(JSON.stringify(badEnvelope));
    expect(result.reportEnvelopeError).toMatch(/summary.*details/);
  });

  it("keeps invalid envelope output in the thread without duplicating stderr", async () => {
    const result = await runCronCommandJob({
      job: {
        ...makeCommandJob({
          kind: "command",
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write('plain report body'); process.stderr.write('debug stderr')",
          ],
          timeoutSeconds: 5,
        }),
        delivery: {
          mode: "announce",
          channel: "slack",
          to: "COPENCLAW",
          presentation: { mode: "threaded_report" },
        },
      },
    });

    expect(result.summary).toBe("stdout:\nplain report body\n\nstderr:\ndebug stderr");
    expect(result.reportDetails).toBe("plain report body\n\nstderr:\ndebug stderr");
    expect(result.reportEnvelopeError).toMatch(/valid JSON/);
  });

  it("marks non-json threaded-report stdout as an invalid envelope", async () => {
    const result = await runCronCommandJob({
      job: {
        ...makeCommandJob({
          kind: "command",
          argv: [process.execPath, "-e", "process.stdout.write('plain report body')"],
          timeoutSeconds: 5,
        }),
        delivery: {
          mode: "announce",
          channel: "slack",
          to: "COPENCLAW",
          presentation: { mode: "threaded_report" },
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("plain report body");
    expect(result.reportDetails).toBe("plain report body");
    expect(result.reportEnvelopeError).toMatch(/valid JSON/);
  });

  it("keeps valid envelope summaries top-level when failed reports write stderr", async () => {
    const envelope = {
      summary:
        "LAX → YYZ daily flight check\nError: RuntimeError: CDP unavailable\nDetails in thread.",
      details: "Traceback (most recent call last):\nRuntimeError: CDP unavailable",
    };
    const result = await runCronCommandJob({
      job: {
        ...makeCommandJob({
          kind: "command",
          argv: [
            process.execPath,
            "-e",
            [
              `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))})`,
              "process.stderr.write('debug stderr')",
              "process.exit(1)",
            ].join(";"),
          ],
          timeoutSeconds: 5,
        }),
        delivery: {
          mode: "announce",
          channel: "slack",
          to: "COPENCLAW",
          presentation: { mode: "threaded_report" },
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.summary).toBe(envelope.summary);
    expect(result.reportDetails).toBe(`${envelope.details}\n\nstderr:\ndebug stderr`);
    expect(result.reportEnvelopeError).toBeUndefined();
  });

  it("leaves JSON stdout unchanged when threaded-report presentation is not configured", async () => {
    const envelope = { summary: "compact", details: "full" };
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [
          process.execPath,
          "-e",
          `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))})`,
        ],
        timeoutSeconds: 5,
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe(JSON.stringify(envelope));
    expect(result.reportDetails).toBeUndefined();
  });

  it("preserves exact NO_REPLY stdout for outbound suppression", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('NO_REPLY\\n')"],
        timeoutSeconds: 5,
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("NO_REPLY");
  });

  it("marks non-zero exit codes as cron errors and keeps stderr as summary", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stderr.write('bad thing'); process.exit(7)"],
        timeoutSeconds: 5,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command exited with code 7");
    expect(result.summary).toBe("bad thing");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      source: "exec",
      severity: "error",
      exitCode: 7,
    });
  });

  it("preserves early action-required command output when the captured tail is truncated", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [
          process.execPath,
          "-e",
          [
            "process.stdout.write('Visit https://example.com/device and enter code ABCD-EFGH\\n')",
            "process.stdout.write('x'.repeat(200))",
          ].join(";"),
        ],
        timeoutSeconds: 5,
        outputMaxBytes: 24,
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe(
      `action-required output preserved:\nVisit https://example.com/device and enter code ABCD-EFGH\n\n${"x".repeat(24)}`,
    );
    expect(result.diagnostics?.summary).toBe(result.summary);
    expect(result.diagnostics?.entries[0]).toMatchObject({ truncated: true });
  });

  it("marks command timeouts as cron errors", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 0.05,
      }),
      nowMs: () => 456,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command timed out");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 456,
      source: "exec",
      severity: "error",
    });
  });

  it.skipIf(process.platform === "win32")("kills shell process groups on timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-command-"));
    const markerPath = path.join(tempDir, "survived");
    const childScript = [
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "alive"), 350)`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const shellCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)}`;

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: ["sh", "-lc", shellCommand],
        timeoutSeconds: 0.05,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command timed out");

    await delay(700);
    await expect(fs.access(markerPath)).rejects.toThrow();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("marks no-output timeouts as cron errors", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 5,
        noOutputTimeoutSeconds: 0.05,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command produced no output before noOutputTimeoutSeconds");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      source: "exec",
      severity: "error",
    });
  });

  it("marks aborted command runs as cron errors", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('should not run')"],
        timeoutSeconds: 5,
      }),
      abortSignal: controller.signal,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command stopped");
    expect(result.summary).toBeUndefined();
  });
});
