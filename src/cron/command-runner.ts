import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  buildCronCommandSummary,
  isCronCommandActionCriticalLine,
} from "./command-output-summary.js";
import type { CronRunDiagnostics, CronRunOutcome, CronRunStatus, CronJob } from "./types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const EFFECTIVELY_UNBOUNDED_TIMEOUT_MS = 2_147_483_647;

function secondsToMs(value: number | undefined): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  if (value <= 0) {
    return EFFECTIVELY_UNBOUNDED_TIMEOUT_MS;
  }
  return finiteSecondsToTimerSafeMilliseconds(value) ?? undefined;
}

function formatCommand(argv: string[]): string {
  return argv.map((arg) => JSON.stringify(arg)).join(" ");
}

function trimOutput(value: string): string | undefined {
  return normalizeOptionalString(value);
}

function appendStderrToReportDetails(params: {
  details: string | undefined;
  stderr: string;
  preservedStderrLines?: string[];
}): string | undefined {
  const stderr = buildCronCommandSummary({
    stdout: "",
    stderr: params.stderr,
    preservedStderrLines: params.preservedStderrLines,
  });
  if (!stderr) {
    return params.details;
  }
  if (!params.details) {
    return `stderr:\n${stderr}`;
  }
  return `${params.details}\n\nstderr:\n${stderr}`;
}

type ScheduledReportEnvelope = {
  summary?: string;
  details?: string;
  error?: string;
};

function parseScheduledReportEnvelope(stdout: string): ScheduledReportEnvelope {
  const trimmed = trimOutput(stdout);
  if (!trimmed) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { details: trimmed, error: "scheduled report envelope must be valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { details: trimmed, error: "scheduled report envelope must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const summary = trimOutput(typeof record.summary === "string" ? record.summary : "");
  const details = trimOutput(typeof record.details === "string" ? record.details : "");
  if (!summary || !details) {
    return {
      details: trimmed,
      error:
        'scheduled report envelope must include non-empty string fields "summary" and "details"',
    };
  }
  return { summary, details };
}

function commandErrorMessage(params: {
  code: number | null;
  signal: NodeJS.Signals | null;
  termination: string;
}): string {
  if (params.termination === "timeout") {
    return "command timed out";
  }
  if (params.termination === "no-output-timeout") {
    return "command produced no output before noOutputTimeoutSeconds";
  }
  if (params.termination === "signal") {
    return params.signal ? `command stopped by signal ${params.signal}` : "command stopped";
  }
  if (typeof params.code === "number") {
    return `command exited with code ${params.code}`;
  }
  return "command failed";
}

function buildDiagnostics(params: {
  command: string;
  status: CronRunStatus;
  summary?: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutTruncatedBytes?: number;
  stderrTruncatedBytes?: number;
  nowMs: () => number;
}): CronRunDiagnostics {
  const truncated =
    Boolean(params.stdoutTruncatedBytes && params.stdoutTruncatedBytes > 0) ||
    Boolean(params.stderrTruncatedBytes && params.stderrTruncatedBytes > 0);
  return {
    ...(params.summary ? { summary: params.summary } : {}),
    entries: [
      {
        ts: params.nowMs(),
        source: "exec",
        severity: params.status === "ok" ? "info" : "error",
        message: params.summary
          ? `command ${params.status}: ${params.command}`
          : `command ${params.status} with no output: ${params.command}`,
        exitCode: params.code,
        truncated,
        ...(params.signal ? { toolName: `signal:${params.signal}` } : {}),
      },
    ],
  };
}

/** Executes a cron command payload without starting an agent/model run. */
export async function runCronCommandJob(params: {
  job: CronJob;
  abortSignal?: AbortSignal;
  nowMs?: () => number;
}): Promise<CronRunOutcome> {
  const nowMs = params.nowMs ?? Date.now;
  const { payload } = params.job;
  if (payload.kind !== "command") {
    return {
      status: "skipped",
      error: 'command runner requires payload.kind="command"',
    };
  }
  if (!Array.isArray(payload.argv) || payload.argv.length === 0) {
    return {
      status: "skipped",
      error: 'command payload requires non-empty "argv"',
    };
  }

  const command = formatCommand(payload.argv);
  const noOutputTimeoutMs = secondsToMs(payload.noOutputTimeoutSeconds);
  try {
    const result = await runCommandWithTimeout(payload.argv, {
      timeoutMs: secondsToMs(payload.timeoutSeconds) ?? DEFAULT_COMMAND_TIMEOUT_MS,
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
      ...(payload.input !== undefined ? { input: payload.input } : {}),
      ...(payload.env ? { env: payload.env } : {}),
      ...(noOutputTimeoutMs !== undefined ? { noOutputTimeoutMs } : {}),
      ...(payload.outputMaxBytes !== undefined ? { maxOutputBytes: payload.outputMaxBytes } : {}),
      preserveOutputLine: isCronCommandActionCriticalLine,
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      killProcessTree: true,
    });
    const ok =
      result.code === 0 &&
      !result.killed &&
      result.termination !== "timeout" &&
      result.termination !== "no-output-timeout" &&
      result.termination !== "signal";
    const status: CronRunStatus = ok ? "ok" : "error";
    const rawSummary = buildCronCommandSummary({
      stdout: result.stdout,
      stderr: result.stderr,
      preservedStdoutLines: result.preservedStdoutLines,
      preservedStderrLines: result.preservedStderrLines,
    });
    const threadedReport = params.job.delivery?.presentation?.mode === "threaded_report";
    const reportEnvelope = threadedReport ? parseScheduledReportEnvelope(result.stdout) : {};
    const summary = threadedReport && reportEnvelope.summary ? reportEnvelope.summary : rawSummary;
    const reportDetails = threadedReport
      ? appendStderrToReportDetails({
          details:
            reportEnvelope.details ??
            buildCronCommandSummary({
              stdout: result.stdout,
              stderr: "",
              preservedStdoutLines: result.preservedStdoutLines,
            }),
          stderr: result.stderr,
          preservedStderrLines: result.preservedStderrLines,
        })
      : undefined;
    const error = ok
      ? undefined
      : commandErrorMessage({
          code: result.code,
          signal: result.signal,
          termination: result.termination,
        });
    return {
      status,
      ...(error ? { error } : {}),
      ...(summary ? { summary } : {}),
      ...(reportDetails ? { reportDetails } : {}),
      ...(reportEnvelope.error ? { reportEnvelopeError: reportEnvelope.error } : {}),
      diagnostics: buildDiagnostics({
        command,
        status,
        summary,
        code: result.code,
        signal: result.signal,
        stdoutTruncatedBytes: result.stdoutTruncatedBytes,
        stderrTruncatedBytes: result.stderrTruncatedBytes,
        nowMs,
      }),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      error,
      diagnostics: {
        summary: error,
        entries: [
          {
            ts: nowMs(),
            source: "exec",
            severity: "error",
            message: `command failed to start: ${command}: ${error}`,
            exitCode: null,
          },
        ],
      },
    };
  }
}
