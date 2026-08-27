import { v2 as cloudinary } from "cloudinary";
import env, { features } from "../config/env.js";
import { ApiError, ERROR_CODES } from "../utils/ApiError.js";

// ISSUES #1 — config is applied lazily on first use rather than at module load,
// so this service is correct regardless of import ordering.
let configured = false;

function ensureConfigured() {
  if (!features.cloudinary) {
    throw new ApiError(503, "Image uploads are not configured on this server.", {
      code: ERROR_CODES.INTEGRATION_DISABLED,
    });
  }
  if (!configured) {
    cloudinary.config({
      cloud_name: env.cloudinary.cloudName,
      api_key: env.cloudinary.apiKey,
      api_secret: env.cloudinary.apiSecret,
      secure: true,
    });
    configured = true;
  }
}

export function isCloudinaryEnabled() {
  return features.cloudinary;
}

/**
 * Uploads one image buffer and resolves with the Cloudinary result.
 * Rejects with an ApiError so the global handler produces a clean message.
 */
export function uploadImageBuffer(buffer, { folder = "transitops" } = {}) {
  ensureConfigured();

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (error, result) => {
        if (error) {
          return reject(
            new ApiError(502, `Image upload failed: ${error.message}`, {
              code: ERROR_CODES.INTEGRATION_FAILED,
            })
          );
        }
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

/**
 * ISSUES #3 — uploads several buffers without letting one failure discard the rest.
 * Returns the URLs that did succeed plus a count of those that did not.
 */
export async function uploadImageBuffers(buffers, options) {
  if (!features.cloudinary) {
    return { urls: [], failed: buffers.length, disabled: true };
  }

  const results = await Promise.allSettled(
    buffers.map((buffer) => uploadImageBuffer(buffer, options))
  );

  const urls = [];
  let failed = 0;

  for (const result of results) {
    if (result.status === "fulfilled") {
      urls.push(result.value.secure_url);
    } else {
      failed += 1;
      console.error("[cloudinary] upload failed:", result.reason?.message);
    }
  }

  return { urls, failed, disabled: false };
}

export default cloudinary;
