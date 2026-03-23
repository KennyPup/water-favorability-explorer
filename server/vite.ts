import { type Server } from "http";
import { type Express } from "express";

export async function setupVite(httpServer: Server, app: Express) {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
