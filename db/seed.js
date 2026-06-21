import { db } from "../server/lib/db.js";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import * as schema from "./schema.js";

async function seed() {
  try {
    // Seed default plans
    const existingPlans = await db.select().from(schema.plans);
    if (!existingPlans || existingPlans.length === 0) {
      await db.insert(schema.plans).values([
        {
          name: "free",
          displayName: "Free",
          price: 0,
          period: "3days",
          maxSessions: 1,
          maxContacts: 100,
          maxTemplates: 5,
          maxScrapeRecords: 10,
          features: JSON.stringify(["1 WhatsApp Session", "100 Contacts", "5 Templates", "Basic Support", "Rate Limiting"]),
          sortOrder: 1,
        },
        {
          name: "silver",
          displayName: "Silver",
          price: 9,
          period: "monthly",
          maxSessions: 3,
          maxContacts: 1000,
          maxTemplates: 25,
          maxScrapeRecords: 50,
          features: JSON.stringify(["3 WhatsApp Sessions", "1,000 Contacts", "25 Templates", "Priority Support", "Schedule Messages"]),
          sortOrder: 2,
        },
        {
          name: "gold",
          displayName: "Gold",
          price: 29,
          period: "monthly",
          maxSessions: 10,
          maxContacts: 10000,
          maxTemplates: 100,
          maxScrapeRecords: 100,
          features: JSON.stringify(["10 WhatsApp Sessions", "10,000 Contacts", "100 Templates", "AI Auto Reply", "API Access"]),
          sortOrder: 3,
        },
        {
          name: "platinum",
          displayName: "Platinum",
          price: 99,
          period: "monthly",
          maxSessions: 9999,
          maxContacts: 999999,
          maxTemplates: 999999,
          maxScrapeRecords: 500,
          features: JSON.stringify(["Unlimited Sessions", "Unlimited Contacts", "Unlimited Templates", "Full API Access", "Custom Integration"]),
          sortOrder: 4,
        },
      ]);
      console.log("Default plans created");
    }

    // Seed admin
    const existing = await db.select().from(schema.users).where(eq(schema.users.email, "parrobyte@gmail.com"));
    if (!existing || existing.length === 0) {
      const hashedPassword = bcrypt.hashSync("ShinChan", 12);
      await db.insert(schema.users).values({
        name: "Administrator",
        email: "parrobyte@gmail.com",
        password: hashedPassword,
        role: "admin",
        plan: "platinum",
        maxSessions: 1,
        countryCode: "+1",
        isActive: true,
        emailVerified: true,
        sessionToken: null,
      });
      console.log("Admin user created: admin@whatsappcrm.com / admin123");
    } else {
      console.log("Admin user already exists");
    }

    process.exit(0);
  } catch (error) {
    console.error("Seed error:", error);
    process.exit(1);
  }
}

seed();
