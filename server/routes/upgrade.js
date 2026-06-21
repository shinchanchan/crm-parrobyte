import express from "express";
import { getFeatureMeta, getFeaturePlanMap, getPlanFeatures } from "../lib/planFeatures.js";
import { db } from "../lib/db.js";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema.js";

const router = express.Router();

router.get("/", async (req, res) => {
  // Credit-based system: redirect to billing for top-ups
  req.flash("info", "We've switched to credit-based billing. Top up credits to use any feature.");
  res.redirect("/billing");
});

export default router;
