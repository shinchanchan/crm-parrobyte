import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  res.render("pages/help/index", {
    title: "Help - ParroByte CRM",
  });
});

export default router;