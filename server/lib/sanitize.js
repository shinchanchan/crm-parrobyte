/**
 * Sanitize a filename to prevent path traversal attacks.
 * Strips path components, keeps only the basename, allows alphanumeric + common safe chars.
 */
export function sanitizeFilename(name) {
  if (!name) return "unnamed";
  // Get basename only (strip any path components)
  const basename = name.replace(/\\/g, "/").split("/").pop() || "unnamed";
  // Replace dangerous chars
  const safe = basename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .substring(0, 200);
  // Ensure it has an extension
  return safe || "unnamed";
}
