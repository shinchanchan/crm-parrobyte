import crypto from "crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;

function getKey() {
  const secret = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET || "default-secret-min-32-chars-long!!";
  return crypto.createHash("sha256").update(secret).digest();
}

export function encrypt(text) {
  if (!text) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

export function decrypt(encryptedBase64) {
  if (!encryptedBase64) return null;
  try {
    const key = getKey();
    const combined = Buffer.from(encryptedBase64, "base64");
    const iv = combined.subarray(0, IV_LEN);
    const authTag = combined.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
    const encrypted = combined.subarray(IV_LEN + AUTH_TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (e) {
    console.error("[Crypto] Decryption failed:", e.message);
    return null;
  }
}
