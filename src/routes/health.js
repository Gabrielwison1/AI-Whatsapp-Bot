import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/", (req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
