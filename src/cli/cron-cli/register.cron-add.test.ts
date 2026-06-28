// Cron add register tests cover create command option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
