import WordExtractor from "word-extractor";

import {
  AI_ATTACHMENT_DOC_MIME_TYPE,
  AI_ATTACHMENT_DOCX_MIME_TYPE,
  AI_ATTACHMENT_IMAGE_MIME_TYPES,
  AI_ATTACHMENT_MAX_EXTRACTED_CHARACTERS,
  AI_ATTACHMENT_PDF_MIME_TYPE,
} from "../config/ai-attachments.js";

import type { Part } from "@google/genai";

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DOC_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_SIGNATURE = Buffer.from("%PDF-");
const RIFF_SIGNATURE = Buffer.from("RIFF");
const WEBP_SIGNATURE = Buffer.from("WEBP");

const IMAGE_MIME_TYPE_SET = new Set<string>(AI_ATTACHMENT_IMAGE_MIME_TYPES);
const wordExtractor = new WordExtractor();

export class AiAttachmentProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiAttachmentProcessingError";
  }
}

function hasSignature(buffer: Buffer, signature: Buffer, offset = 0): boolean {
  return buffer.subarray(offset, offset + signature.length).equals(signature);
}

function hasValidFileSignature(file: Express.Multer.File): boolean {
  switch (file.mimetype) {
    case "image/jpeg":
      return hasSignature(file.buffer, JPEG_SIGNATURE);
    case "image/png":
      return hasSignature(file.buffer, PNG_SIGNATURE);
    case "image/webp":
      return (
        hasSignature(file.buffer, RIFF_SIGNATURE) &&
        hasSignature(file.buffer, WEBP_SIGNATURE, 8)
      );
    case AI_ATTACHMENT_PDF_MIME_TYPE:
      return hasSignature(file.buffer, PDF_SIGNATURE);
    case AI_ATTACHMENT_DOC_MIME_TYPE:
      return hasSignature(file.buffer, DOC_SIGNATURE);
    case AI_ATTACHMENT_DOCX_MIME_TYPE:
      return hasSignature(file.buffer, ZIP_SIGNATURE);
    default:
      return false;
  }
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160) || "attachment";
}

function createInlineMediaParts(file: Express.Multer.File, fileName: string): Part[] {
  return [
    { text: `Attached file \"${fileName}\" follows.` },
    {
      inlineData: {
        data: file.buffer.toString("base64"),
        displayName: fileName,
        mimeType: file.mimetype,
      },
    },
  ];
}

async function createWordDocumentPart(
  file: Express.Multer.File,
  fileName: string,
): Promise<Part> {
  try {
    const document = await wordExtractor.extract(file.buffer);
    const body = document.getBody().trim();

    if (!body) {
      throw new AiAttachmentProcessingError(`${fileName} does not contain readable text.`);
    }

    const isTruncated = body.length > AI_ATTACHMENT_MAX_EXTRACTED_CHARACTERS;
    const text = body.slice(0, AI_ATTACHMENT_MAX_EXTRACTED_CHARACTERS);
    const truncationNotice = isTruncated
      ? "\n[The document was truncated because it exceeded the text processing limit.]"
      : "";

    return {
      text: `[Attached Word document: ${fileName}]\n${text}${truncationNotice}\n[End of ${fileName}]`,
    };
  } catch (error) {
    if (error instanceof AiAttachmentProcessingError) {
      throw error;
    }

    throw new AiAttachmentProcessingError(
      `${fileName} could not be read. Re-save it as DOCX or PDF and try again.`,
    );
  }
}

export async function prepareAiAttachmentParts(
  files: readonly Express.Multer.File[],
): Promise<Part[]> {
  const parts: Part[] = [];

  for (const file of files) {
    const fileName = sanitizeFileName(file.originalname);

    if (!hasValidFileSignature(file)) {
      throw new AiAttachmentProcessingError(`${fileName} does not match its declared file type.`);
    }

    if (IMAGE_MIME_TYPE_SET.has(file.mimetype) || file.mimetype === AI_ATTACHMENT_PDF_MIME_TYPE) {
      parts.push(...createInlineMediaParts(file, fileName));
      continue;
    }

    parts.push(await createWordDocumentPart(file, fileName));
  }

  return parts;
}
