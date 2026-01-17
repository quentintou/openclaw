import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "grammy";

import { deliverReplies } from "./delivery.js";

const loadWebMedia = vi.fn();

vi.mock("../../web/media.js", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
}));

vi.mock("grammy", () => ({
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
}));

describe("deliverReplies", () => {
  beforeEach(() => {
    loadWebMedia.mockReset();
  });

  it("skips audioAsVoice-only payloads without logging an error", async () => {
    const runtime = { error: vi.fn() };
    const bot = { api: {} } as unknown as Bot;

    await deliverReplies({
      replies: [{ audioAsVoice: true }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
    });

    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("invokes onVoiceRecording before sending a voice note", async () => {
    const events: string[] = [];
    const runtime = { error: vi.fn() };
    const sendVoice = vi.fn(async () => {
      events.push("sendVoice");
      return { message_id: 1, chat: { id: "123" } };
    });
    const bot = { api: { sendVoice } } as unknown as Bot;
    const onVoiceRecording = vi.fn(async () => {
      events.push("recordVoice");
    });

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    await deliverReplies({
      replies: [{ mediaUrl: "https://example.com/note.ogg", audioAsVoice: true }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
      onVoiceRecording,
    });

    expect(onVoiceRecording).toHaveBeenCalledTimes(1);
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["recordVoice", "sendVoice"]);
  });

  it("splits long captions into media + follow-up text after the first media", async () => {
    const events: string[] = [];
    const runtime = { error: vi.fn() };
    const sendPhoto = vi.fn(async () => {
      events.push("photo");
      return { message_id: 1, chat: { id: "123" } };
    });
    const sendMessage = vi.fn(async () => {
      events.push("text");
      return { message_id: 2, chat: { id: "123" } };
    });
    const bot = { api: { sendPhoto, sendMessage } } as unknown as Bot;
    const longText = "A".repeat(1100);

    loadWebMedia
      .mockResolvedValueOnce({
        buffer: Buffer.from("photo-a"),
        contentType: "image/jpeg",
        fileName: "a.jpg",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("photo-b"),
        contentType: "image/jpeg",
        fileName: "b.jpg",
      });

    await deliverReplies({
      replies: [{ text: longText, mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"] }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
    });

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expect(sendPhoto).toHaveBeenNthCalledWith(
      1,
      "123",
      expect.anything(),
      expect.objectContaining({ caption: undefined }),
    );
    expect(sendMessage).toHaveBeenCalledWith("123", longText, {});
    expect(events).toEqual(["photo", "text", "photo"]);
  });
});
