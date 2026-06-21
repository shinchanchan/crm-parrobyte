import express from "express";
import { db } from "../lib/db.js";
import { eq, and, count, sql } from "drizzle-orm";
import { getUserCredits } from "../lib/credits.js";
import * as schema from "../../db/schema.js";
import { getSharedSession } from "../lib/sessions.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    
    // Get counts
    let sessionsQuery = isAdmin 
      ? db.select().from(schema.whatsappSessions)
      : db.select().from(schema.whatsappSessions).where(eq(schema.whatsappSessions.userId, userId));
    
    let contactsQuery = isAdmin
      ? db.select().from(schema.contacts)
      : db.select().from(schema.contacts).where(eq(schema.contacts.userId, userId));
    
    let templatesQuery = isAdmin
      ? db.select().from(schema.templates)
      : db.select().from(schema.templates).where(eq(schema.templates.userId, userId));
    
    let messagesQuery = isAdmin
      ? db.select().from(schema.messages)
      : db.select().from(schema.messages).where(eq(schema.messages.userId, userId));
    
    const [sessions, contacts, templates, messages] = await Promise.all([
      sessionsQuery,
      contactsQuery,
      templatesQuery,
      messagesQuery,
    ]);
    
    const totalSessions = sessions.length;
    const activeSessions = sessions.filter(s => s.status === "connected").length;
    const totalContacts = contacts.length;
    const totalTemplates = templates.length;
    const totalMessages = messages.length;
    const sentMessages = messages.filter(m => m.status === "sent").length;
    const failedMessages = messages.filter(m => m.status === "failed").length;
    
    // Recent activity
    const recentMessages = messages.slice(0, 10);
    const recentContacts = contacts.slice(0, 5);
    
    // User info + credits
    const user = await db.select().from(schema.users)
      .where(eq(schema.users.id, userId));
    const creditBalance = await getUserCredits(userId);
    
    const sharedSession = await getSharedSession();
    
    res.render("pages/dashboard/index", {
      title: "Dashboard - ParroByte CRM",
      stats: {
        totalSessions,
        activeSessions,
        totalContacts,
        totalTemplates,
        totalMessages,
        sentMessages,
        failedMessages,
      },
      recentMessages,
      recentContacts,
      sessions,
      sharedSession,
      planInfo: user[0],
      creditBalance,
      isAdmin,
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    req.flash("error", "Failed to load dashboard");
    res.redirect("/");
  }
});

export default router;