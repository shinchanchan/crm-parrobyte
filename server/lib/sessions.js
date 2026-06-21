import { db } from "./db.js";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema.js";

/**
 * Resolve the WhatsApp session to use for a given user.
 *
 * Logic:
 * 1. If user is admin and provided a sessionId, use it.
 * 2. If a shared session exists (isShared=true, status='connected'),
 *    non-admin users automatically use it.
 * 3. Fallback: user's own connected session.
 *
 * Returns: { sessionId: number|null, session: object|null, error: string|null }
 */
export async function resolveSessionForUser({ userId, isAdmin, providedSessionId }) {
  // Admin with explicit sessionId — use it
  if (isAdmin && providedSessionId) {
    const session = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.id, parseInt(providedSessionId)));
    if (!session.length) {
      return { sessionId: null, session: null, error: "Session not found" };
    }
    return { sessionId: session[0].id, session: session[0], error: null };
  }

  // Non-admin: look for a shared admin session first
  if (!isAdmin) {
    const sharedSessions = await db.select().from(schema.whatsappSessions)
      .where(and(
        eq(schema.whatsappSessions.isShared, true),
        eq(schema.whatsappSessions.status, "connected")
      ));
    if (sharedSessions.length) {
      return { sessionId: sharedSessions[0].id, session: sharedSessions[0], error: null };
    }
  }

  // Fallback: user's own connected session
  const userSessions = await db.select().from(schema.whatsappSessions)
    .where(eq(schema.whatsappSessions.userId, userId));
  const connected = userSessions.find(s => s.status === "connected");
  if (connected) {
    return { sessionId: connected.id, session: connected, error: null };
  }

  // No session found at all
  return {
    sessionId: null,
    session: null,
    error: "No connected WhatsApp session found. Please ask your admin to configure a shared session.",
  };
}

/**
 * Get the current shared session (if any)
 */
export async function getSharedSession() {
  const sessions = await db.select().from(schema.whatsappSessions)
    .where(and(
      eq(schema.whatsappSessions.isShared, true),
      eq(schema.whatsappSessions.status, "connected")
    ));
  return sessions[0] || null;
}
