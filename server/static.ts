import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(process.cwd(), "dist", "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find build directory: ${distPath}. Run 'npm run build' first.`
    );
  }
  app.use(express.static(distPath));
  app.use("/*path", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
