import multer from "multer";

import {
  AI_ATTACHMENT_MAX_COUNT,
  AI_ATTACHMENT_MAX_SIZE_BYTES,
  AI_ATTACHMENT_SUPPORTED_MIME_TYPES,
} from "../config/ai-attachments.js";

import type { NextFunction, Request, Response } from "express";

class UnsupportedAiAttachmentError extends Error {
  constructor(fileName: string) {
    super(`${fileName} uses an unsupported file type.`);
    this.name = "UnsupportedAiAttachmentError";
  }
}

const upload = multer({
  fileFilter: (_request, file, callback) => {
    if (!AI_ATTACHMENT_SUPPORTED_MIME_TYPES.has(file.mimetype)) {
      callback(new UnsupportedAiAttachmentError(file.originalname));
      return;
    }

    callback(null, true);
  },
  limits: {
    fileSize: AI_ATTACHMENT_MAX_SIZE_BYTES,
    files: AI_ATTACHMENT_MAX_COUNT,
  },
  storage: multer.memoryStorage(),
});

const parseAttachmentArray = upload.array("attachments", AI_ATTACHMENT_MAX_COUNT);

export function parseAiChatAttachments(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  parseAttachmentArray(request, response, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof UnsupportedAiAttachmentError) {
      response.status(400).json({ error: error.message });
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        response.status(413).json({ error: "Each attachment must be 10 MB or smaller." });
        return;
      }

      if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
        response.status(400).json({ error: "You can attach up to 5 files." });
        return;
      }
    }

    next(error);
  });
}
