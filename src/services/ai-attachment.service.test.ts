import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { AiAttachmentProcessingError, prepareAiAttachmentParts } from "./ai-attachment.service.js";

interface TestFileOptions {
  buffer: Buffer;
  mimeType: string;
  name: string;
}

function createTestFile({ buffer, mimeType, name }: TestFileOptions): Express.Multer.File {
  return {
    buffer,
    destination: "",
    encoding: "7bit",
    fieldname: "attachments",
    filename: name,
    mimetype: mimeType,
    originalname: name,
    path: "",
    size: buffer.length,
    stream: Readable.from(buffer),
  };
}

describe("prepareAiAttachmentParts", () => {
  it("converts a verified image into a labelled Gemini inline-data part", async () => {
    const buffer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("image-data")]);
    const file = createTestFile({ buffer, mimeType: "image/jpeg", name: "boarding-pass.jpg" });

    const parts = await prepareAiAttachmentParts([file]);

    expect(parts).toHaveLength(2);
    expect(parts[0]?.text).toContain("boarding-pass.jpg");
    expect(parts[1]?.inlineData).toMatchObject({
      data: buffer.toString("base64"),
      displayName: "boarding-pass.jpg",
      mimeType: "image/jpeg",
    });
  });

  it("passes a verified PDF as native document data", async () => {
    const buffer = Buffer.from("%PDF-1.7\nmock document");
    const file = createTestFile({ buffer, mimeType: "application/pdf", name: "report.pdf" });

    const parts = await prepareAiAttachmentParts([file]);

    expect(parts[1]?.inlineData?.mimeType).toBe("application/pdf");
    expect(parts[1]?.inlineData?.data).toBe(buffer.toString("base64"));
  });

  it("rejects a spoofed MIME type before sending bytes to Gemini", async () => {
    const file = createTestFile({
      buffer: Buffer.from("this is not a png"),
      mimeType: "image/png",
      name: "spoofed.png",
    });

    await expect(prepareAiAttachmentParts([file])).rejects.toEqual(
      new AiAttachmentProcessingError("spoofed.png does not match its declared file type."),
    );
  });
});
