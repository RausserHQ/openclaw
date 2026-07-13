// Cron add register tests cover create command option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");

function createCronProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronAddCommand(program);
  return program;
}

describe("cron add command", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ id: "job-1" });
  });

  it("creates opt-in threaded report presentation for command scheduled reports", async () => {
    const program = createCronProgram();

    await program.parseAsync(
      [
        "add",
        "--name",
        "Sam flight check",
        "--cron",
        "0 7 * * *",
        "--command",
        "openclaw-sam-flight-check",
        "--channel",
        "slack",
        "--to",
        "COPENCLAW",
        "--threaded-report",
      ],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({ threadedReport: true }),
      expect.objectContaining({
        payload: { kind: "command", argv: ["sh", "-lc", "openclaw-sam-flight-check"] },
        delivery: expect.objectContaining({
          mode: "announce",
          channel: "slack",
          to: "COPENCLAW",
          presentation: { mode: "threaded_report" },
        }),
      }),
    );
  });

  it("rejects threaded reports outside Slack before calling the gateway", async () => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation((() => undefined) as never);
    const program = createCronProgram();

    await program.parseAsync(
      [
        "add",
        "--name",
        "Telegram report",
        "--cron",
        "0 7 * * *",
        "--command",
        "openclaw-telegram-flight-check",
        "--channel",
        "telegram",
        "--to",
        "-100123",
        "--threaded-report",
      ],
      { from: "user" },
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--threaded-report requires --channel slack."),
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("accepts Slack-prefixed delivery targets with the default channel", async () => {
    const program = createCronProgram();

    await program.parseAsync(
      [
        "add",
        "--name",
        "Prefixed Slack report",
        "--cron",
        "0 7 * * *",
        "--command",
        "openclaw-slack-flight-check",
        "--to",
        "slack:COPENCLAW",
        "--threaded-report",
      ],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({ threadedReport: true }),
      expect.objectContaining({
        delivery: expect.objectContaining({
          channel: "last",
          to: "slack:COPENCLAW",
          presentation: { mode: "threaded_report" },
        }),
      }),
    );
  });
});
