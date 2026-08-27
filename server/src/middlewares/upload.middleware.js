import multer from "multer";
import { badRequest, ERROR_CODES } from "../utils/ApiError.js";

const storage = multer.memoryStorage();

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function imageFileFilter(req, file, cb) {
  if (!file.mimetype?.startsWith("image/")) {
    // Surface a typed error so the handler below can produce a clear message.
    const error = new Error("Only image files are allowed");
    error.code = "LIMIT_UNEXPECTED_FILE_TYPE";
    return cb(error);
  }
  cb(null, true);
}

export const upload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

/**
 * Translates multer's terse error codes into messages a user can act on.
 * Wrap an upload middleware with this so failures become 400s with a clear
 * reason instead of an opaque 500.
 */
export function handleUploadErrors(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (error) => {
      if (!error) return next();

      if (error instanceof multer.MulterError) {
        switch (error.code) {
          case "LIMIT_FILE_SIZE":
            return next(
              badRequest(
                `Each image must be smaller than ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`,
                ERROR_CODES.PAYLOAD_TOO_LARGE
              )
            );
          case "LIMIT_FILE_COUNT":
          case "LIMIT_UNEXPECTED_FILE":
            return next(
              badRequest("Too many files uploaded, or an unexpected field name was used.")
            );
          default:
            return next(badRequest(`Upload failed: ${error.message}`));
        }
      }

      if (error.code === "LIMIT_UNEXPECTED_FILE_TYPE") {
        return next(badRequest("Only image files (JPG, PNG, WebP) can be uploaded."));
      }

      return next(error);
    });
  };
}

export default upload;
