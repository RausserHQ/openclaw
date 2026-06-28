// Cron threaded-report delivery tests verify root + first threaded reply transport behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendDurableMessageBatch = vi.fn();

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatch: (...args: unknown[]) => sendDurableMessageBatch(...args),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: vi.fn(async () => ({
    ok: true,
    channel: "slack",
    to: "COPENCLAW",
    accountId: "sam-bot",
  })),
}));

const { sendCronAnnouncePayloadStrict } = await import("./delivery.js");

describe("sendCronAnnouncePayloadStrict threaded reports", () => {
  beforeEach(() => {
    sendDurableMessageBatch.mockReset();
    sendDurableMessageBatch
      .mockResolvedValueOnce({
        status: "sent",
        results: [],
        receipt: {
          primaryPlatformMessageId: "root-ts",
          platformMessageIds: ["root-ts"],
          parts: [],
          sentAt: 123,
        },
      })
      .mockResolvedValueOnce({
        status: "sent",
        results: [],
        receipt: {
          primaryPlatformMessageId: "reply-ts",
          platformMessageIds: ["reply-ts"],
          parts: [],
          sentAt: 124,
        },
      });
  });

  it("posts compact root without inherited thread and full report as first threaded reply", async () => {
    await sendCronAnnouncePayloadStrict({
      deps: {} as never,
      cfg: {} as never,
      agentId: "sam",
      jobId: "flight-check",
      target: {
        channel: "slack",
        to: "COPENCLAW",
        accountId: "sam-bot",
      },
      message: "LAX → YYZ daily flight check\nLowest: $3,679 total / $613 pp\nDetails in thread.",
      detailsMessage: "browser/source info\nfull search parameters\nall best options",
      abortSignal: new AbortController().signal,
    });

    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
    expect(sendDurableMessageBatch.mock.calls[0]?.[0]).toMatchObject({
      channel: "slack",
      to: "COPENCLAW",
      accountId: "sam-bot",
      threadId: undefined,
      payloads: [{ text: expect.stringContaining("Lowest:") }],
    });
    expect(sendDurableMessageBatch.mock.calls[1]?.[0]).toMatchObject({
      channel: "slack",
      to: "COPENCLAW",
      accountId: "sam-bot",
      threadId: "root-ts",
      payloads: [{ text: expect.stringContaining("full search parameters") }],
    });
  });

  it("fails closed when the adapter does not return a threadable root receipt id", async () => {
    sendDurableMessageBatch.mockReset();
    sendDurableMessageBatch.mockResolvedValueOnce({
      status: "sent",
      results: [],
      receipt: {
        platformMessageIds: [],
        parts: [],
        sentAt: 123,
      },
    });

    await expect(
      sendCronAnnouncePayloadStrict({
        deps: {} as never,
        cfg: {} as never,
        agentId: "sam",
        jobId: "flight-check",
        target: {
          channel: "slack",
          to: "COPENCLAW",
          accountId: "sam-bot",
        },
        message: "LAX → YYZ daily flight check\nDetails in thread.",
        detailsMessage: "full report",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/could not resolve root message id/);

    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
  });
});
