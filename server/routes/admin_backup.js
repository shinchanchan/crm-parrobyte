import express from "express";
import { db } from "../lib/db.js";
import { eq, desc, sql } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { paginate } from "../lib/paginate.js";
import { getAllCreditConfigs, getAllCreditConfigsAdmin, addCredits } from "../lib/credits.js";

const router = express.Router();

// Admin dashboard stats
router.get("/", async (req, res) => {
  try {
    // Use COUNT queries instead of loading ALL data into memory
    const totalContactsResult = await db.select({ count: schema.contacts.id }).from(schema.contacts);
    const totalMessagesResult = await db.select({ count: schema.messages.id }).from(schema.messages);
    const sentMessagesResult = await db.select({ count: schema.messages.id }).from(schema.messages).where(eq(schema.messages.status, "sent"));
    const totalTemplatesResult = await db.select({ count: schema.templates.id }).from(schema.templates);
    const totalInvoicesResult = await db.select({ count: schema.invoices.id }).from(schema.invoices);
    const paidInvoicesResult = await db.select({ amount: schema.invoices.amount }).from(schema.invoices).where(eq(schema.invoices.status, "paid"));
    const recentMessagesResult = await db.select().from(schema.messages).orderBy(desc(schema.messages.createdAt)).limit(20);

    // Admin only sees their OWN sessions, not other users'
    const sessions = await db.select().from(schema.whatsappSessions)
      .where(eq(schema.whatsappSessions.userId, req.session.user.id));

    const totalUsersResult = await db.select({ count: schema.users.id }).from(schema.users);
    const totalUsers = totalUsersResult.length;
    const activeUsersResult = await db.select({ count: schema.users.id }).from(schema.users).where(eq(schema.users.isActive, true));
    const activeUsers = activeUsersResult.length;
    const totalSessions = sessions.length;
    const connectedSessions = sessions.filter(s => s.status === "connected").length;
    const totalContacts = totalContactsResult.length;
    const totalMessages = totalMessagesResult.length;
    const sentMessages = sentMessagesResult.length;
    const totalRevenue = paidInvoicesResult.reduce((sum, i) => sum + (i.amount || 0), 0);

    // Paginated users table with per-column search
    const userResult = await paginate({
      db,
      schema: schema.users,
      req,
      searchableColumns: ["name", "email", "role"],
      defaultSort: { column: schema.users.createdAt, dir: "desc" },
    });

    // Enrich users with their session counts
    const userSessionCounts = new Map();
    for (const u of userResult.data) {
      const sRows = await db.select({ count: sql`count(*)` }).from(schema.whatsappSessions).where(eq(schema.whatsappSessions.userId, u.id));
      userSessionCounts.set(u.id, parseInt(sRows[0]?.count || 0, 10));
    }

    res.render("pages/admin/index", {
      title: "Admin Panel - ParroByte CRM",
      stats: { totalUsers, activeUsers, totalSessions, connectedSessions, totalContacts, totalMessages, sentMessages, totalRevenue },
      users: userResult.data,
      userPagination: userResult.pagination,
      userColumnFilters: userResult.columnFilters,
      userSortCol: userResult.sortCol,
      userSortDir: userResult.sortDir,
      sessions,
      recentMessages: recentMessagesResult,
      userSessionCounts,
    });
  } catch (error) {
    console.error("Admin error:", error);
    req.flash("error", "Failed to load admin panel");
    res.redirect("/dashboard");
  }
});

// Credit configuration
router.get("/credits", async (req, res) => {
  try {
    const configs = await getAllCreditConfigsAdmin();
    res.render("pages/admin/credits", {
      title: "Credit Configuration - ParroByte CRM",
      configs,
    });
  } catch (error) {
    req.flash("error", "Failed to load credit configs");
    res.redirect("/admin");
  }
});

router.post("/credits/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { cost, isActive, isVisible } = req.body;

    await db.update(schema.creditConfigs)
      .set({
        cost: parseFloat(cost) || 1,
        isActive: isActive === "on" || isActive === true,
        isVisible: isVisible === "on" || isVisible === true,
        freeQuota: parseInt(req.body.freeQuota) || 0,
        updatedAt: new Date(),
      })
      .where(eq(schema.creditConfigs.id, id));

    req.flash("success", "Credit config updated");
    res.redirect("/admin/credits");
  } catch (error) {
    req.flash("error", "Failed to update credit config");
    res.redirect("/admin/credits");
  }
});

// Add credits to user (admin)
router.post("/user/add-credits/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, reason } = req.body;
    const creditAmount = parseInt(amount) || 0;

    if (creditAmount <= 0) {
      req.flash("error", "Invalid credit amount");
      return res.redirect("/admin");
    }

    await addCredits(parseInt(id), creditAmount, "admin_bonus", reason || "Admin credit grant");
    req.flash("success", `Added ${creditAmount} credits to user`);
    res.redirect("/admin");
  } catch (error) {
    req.flash("error", "Failed to add credits");
    res.redirect("/admin");
  }
});

// User management
router.post("/user/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, isActive, maxSessions } = req.body;

    const updates = {
      name,
      email,
      role,
      isActive: isActive === "on" || isActive === true || isActive === "true",
    };

    // Handle maxSessions admin override (empty string = remove override, use plan limit)
    if (maxSessions !== undefined) {
      const parsed = parseInt(maxSessions, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        updates.maxSessions = parsed;
      } else if (maxSessions === "" || maxSessions === null) {
        updates.maxSessions = null;
      }
    }

    await db.update(schema.users)
      .set(updates)
      .where(eq(schema.users.id, id));

    req.flash("success", "User updated");
    res.redirect("/admin");
  } catch (error) {
    console.error("Update user error:", error);
    req.flash("error", "Failed to update user");
    res.redirect("/admin");
  }
});

router.post("/user/toggle/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const user = await db.select().from(schema.users)
      .where(eq(schema.users.id, id));

    if (!user.length) {
      req.flash("error", "User not found");
      return res.redirect("/admin");
    }

    await db.update(schema.users)
      .set({ isActive: !user[0].isActive })
      .where(eq(schema.users.id, id));

    req.flash("success", `User ${user[0].isActive ? "disabled" : "enabled"}`);
    res.redirect("/admin");
  } catch (error) {
    req.flash("error", "Failed to toggle user");
    res.redirect("/admin");
  }
});



router.post("/session/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await req.waManager.disconnectSession(id);

    await db.delete(schema.whatsappSessions).where(eq(schema.whatsappSessions.id, id));

    req.flash("success", "Session deleted");
    res.redirect("/admin");
  } catch (error) {
    req.flash("error", "Failed to delete session");
    res.redirect("/admin");
  }
});

// Landing enquiries admin page
router.get("/landing-enquiries", async (req, res) => {
  try {
    const enquiries = await db.select().from(schema.landingEnquiries)
      .orderBy(desc(schema.landingEnquiries.createdAt));
    res.render("pages/admin/landingEnquiries", {
      title: "Landing Enquiries - ParroByte CRM",
      enquiries,
    });
  } catch (error) {
    console.error("Admin landing enquiries error:", error);
    req.flash("error", "Failed to load landing enquiries");
    res.redirect("/admin");
  }
});

// Service packages admin page
router.get("/service-packages", async (req, res) => {
  try {
    const packages = await db.select().from(schema.servicePackages)
      .orderBy(schema.servicePackages.sortOrder);
    const configs = await getAllCreditConfigs();
    res.render("pages/admin/servicePackages", {
      title: "Service Packages - ParroByte CRM",
      packages,
      configs,
    });
  } catch (error) {
    console.error("Admin service packages error:", error);
    req.flash("error", "Failed to load service packages");
    res.redirect("/admin");
  }
});

router.post("/service-packages/create", async (req, res) => {
  try {
    const { serviceKey, serviceName, credits, price, description, sortOrder } = req.body;
    await db.insert(schema.servicePackages).values({
      serviceKey,
      serviceName,
      credits: parseInt(credits) || 0,
      price: parseInt(price) || 0,
      description: description || null,
      sortOrder: parseInt(sortOrder) || 0,
    });
    req.flash("success", "Service package created");
    res.redirect("/admin/service-packages");
  } catch (error) {
    console.error("Create service package error:", error);
    req.flash("error", "Failed to create service package");
    res.redirect("/admin/service-packages");
  }
});

router.post("/service-packages/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { serviceKey, serviceName, credits, price, description, isActive, sortOrder } = req.body;
    await db.update(schema.servicePackages)
      .set({
        serviceKey,
        serviceName,
        credits: parseInt(credits) || 0,
        price: parseInt(price) || 0,
        description: description || null,
        isActive: isActive === "on" || isActive === true,
        sortOrder: parseInt(sortOrder) || 0,
      })
      .where(eq(schema.servicePackages.id, id));
    req.flash("success", "Service package updated");
    res.redirect("/admin/service-packages");
  } catch (error) {
    console.error("Update service package error:", error);
    req.flash("error", "Failed to update service package");
    res.redirect("/admin/service-packages");
  }
});

router.post("/service-packages/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(schema.servicePackages).where(eq(schema.servicePackages.id, id));
    req.flash("success", "Service package deleted");
    res.redirect("/admin/service-packages");
  } catch (error) {
    console.error("Delete service package error:", error);
    req.flash("error", "Failed to delete service package");
    res.redirect("/admin/service-packages");
  }
});

router.get("/activity-logs", async (req, res) => {
  try {
    const logs = await db.select().from(schema.activityLogs).orderBy(schema.activityLogs.createdAt);

    res.render("pages/admin/activityLogs", {
      title: "Activity Logs - ParroByte CRM",
      logs,
    });
  } catch (error) {
    req.flash("error", "Failed to load activity logs");
    res.redirect("/admin");
  }
});

export default router;
