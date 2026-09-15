import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import webhookRouter from "./routes/webhook.js";
import { healthRouter } from "./routes/health.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use("/webhook", webhookRouter);
app.use("/health", healthRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("[GLOBAL ERROR]", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[SERVER] ProseMedistore WhatsApp Router listening on port ${PORT}`);
  console.log(`[SERVER] AI Provider: ${process.env.AI_PROVIDER || "gemini"}`);
});

export default app;
