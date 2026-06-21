import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  const apiKey = req.query.apiKey || "wcrm_your_api_key_here";
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  
  res.render("pages/developer/index", {
    title: "Developer API - ParroByte CRM",
    apiKey,
    baseUrl,
  });
});

export default router;