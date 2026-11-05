export const AI_ATTACHMENT_MAX_COUNT = 5;
export const AI_ATTACHMENT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const AI_ATTACHMENT_MAX_EXTRACTED_CHARACTERS = 100_000;

export const AI_ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const AI_ATTACHMENT_PDF_MIME_TYPE = "application/pdf";
export const AI_ATTACHMENT_DOC_MIME_TYPE = "application/msword";
export const AI_ATTACHMENT_DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const AI_ATTACHMENT_SUPPORTED_MIME_TYPES = new Set<string>([
  ...AI_ATTACHMENT_IMAGE_MIME_TYPES,
  AI_ATTACHMENT_PDF_MIME_TYPE,
  AI_ATTACHMENT_DOC_MIME_TYPE,
  AI_ATTACHMENT_DOCX_MIME_TYPE,
]);
