import express from "express";
import { db } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { checkCredits, chargeCredits } from "../lib/credits.js";

const router = express.Router();

// List questionnaires for the user
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";

    const questionnaires = await db.select().from(schema.sessionQuestionnaires)
      .where(isAdmin ? undefined : eq(schema.sessionQuestionnaires.userId, userId))
      .orderBy(desc(schema.sessionQuestionnaires.createdAt));

    // Get questions for each questionnaire
    for (const q of questionnaires) {
      const questions = await db.select().from(schema.sessionQuestionnaireQuestions)
        .where(eq(schema.sessionQuestionnaireQuestions.questionnaireId, q.id))
        .orderBy(schema.sessionQuestionnaireQuestions.sortOrder);
      q.questions = questions;
    }

    res.render("pages/questionnaires/index", {
      title: "Session Questionnaires - ParroByte CRM",
      questionnaires,
      isAdmin,
    });
  } catch (error) {
    console.error("[Questionnaires] List error:", error.message);
    req.flash("error", "Failed to load questionnaires");
    res.redirect("/dashboard");
  }
});

// Create questionnaire
router.post("/create", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { name, description } = req.body;

    if (!name || name.trim().length < 2) {
      req.flash("error", "Questionnaire name must be at least 2 characters");
      return res.redirect("/questionnaires");
    }

    const result = await db.insert(schema.sessionQuestionnaires).values({
      userId,
      name: name.trim(),
      description: description || null,
      isActive: true,
    }).returning();

    req.flash("success", `Questionnaire "${name.trim()}" created. Now add questions.`);
    res.redirect("/questionnaires");
  } catch (error) {
    console.error("[Questionnaires] Create error:", error.message);
    req.flash("error", "Failed to create questionnaire");
    res.redirect("/questionnaires");
  }
});

// Add question to questionnaire
router.post("/add-question/:questionnaireId", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const questionnaireId = parseInt(req.params.questionnaireId);
    const { questionText, questionType, options, sortOrder, isRequired, mapToLeadField } = req.body;

    // Verify ownership
    const qnaires = await db.select().from(schema.sessionQuestionnaires)
      .where(eq(schema.sessionQuestionnaires.id, questionnaireId));
    if (!qnaires.length || (qnaires[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/questionnaires");
    }

    if (!questionText || questionText.trim().length < 2) {
      req.flash("error", "Question text is required");
      return res.redirect("/questionnaires");
    }

    let parsedOptions = null;
    if (questionType === "select" && options) {
      try {
        const arr = JSON.parse(options);
        parsedOptions = JSON.stringify(arr);
      } catch {
        // comma-separated
        parsedOptions = JSON.stringify(options.split(",").map(o => o.trim()).filter(o => o));
      }
    }

    await db.insert(schema.sessionQuestionnaireQuestions).values({
      questionnaireId,
      questionText: questionText.trim(),
      questionType: questionType || "text",
      options: parsedOptions,
      sortOrder: parseInt(sortOrder) || 0,
      isRequired: isRequired === "on" || isRequired === true,
      mapToLeadField: mapToLeadField || null,
    });

    req.flash("success", "Question added");
    res.redirect("/questionnaires");
  } catch (error) {
    console.error("[Questionnaires] Add question error:", error.message);
    req.flash("error", "Failed to add question");
    res.redirect("/questionnaires");
  }
});

// Delete question
router.post("/delete-question/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const questionId = parseInt(req.params.id);

    const questions = await db.select().from(schema.sessionQuestionnaireQuestions)
      .where(eq(schema.sessionQuestionnaireQuestions.id, questionId));
    if (!questions.length) {
      req.flash("error", "Question not found");
      return res.redirect("/questionnaires");
    }

    const qnaires = await db.select().from(schema.sessionQuestionnaires)
      .where(eq(schema.sessionQuestionnaires.id, questions[0].questionnaireId));
    if (!qnaires.length || (qnaires[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/questionnaires");
    }

    await db.delete(schema.sessionQuestionnaireQuestions)
      .where(eq(schema.sessionQuestionnaireQuestions.id, questionId));

    req.flash("success", "Question deleted");
    res.redirect("/questionnaires");
  } catch (error) {
    console.error("[Questionnaires] Delete question error:", error.message);
    req.flash("error", "Failed to delete question");
    res.redirect("/questionnaires");
  }
});

// Delete questionnaire
router.post("/delete/:id", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isAdmin = req.session.user.role === "admin";
    const id = parseInt(req.params.id);

    const qnaires = await db.select().from(schema.sessionQuestionnaires)
      .where(eq(schema.sessionQuestionnaires.id, id));
    if (!qnaires.length || (qnaires[0].userId !== userId && !isAdmin)) {
      req.flash("error", "Unauthorized");
      return res.redirect("/questionnaires");
    }

    // Delete questions first
    await db.delete(schema.sessionQuestionnaireQuestions)
      .where(eq(schema.sessionQuestionnaireQuestions.questionnaireId, id));

    await db.delete(schema.sessionQuestionnaires)
      .where(eq(schema.sessionQuestionnaires.id, id));

    req.flash("success", "Questionnaire deleted");
    res.redirect("/questionnaires");
  } catch (error) {
    console.error("[Questionnaires] Delete error:", error.message);
    req.flash("error", "Failed to delete questionnaire");
    res.redirect("/questionnaires");
  }
});

export default router;
