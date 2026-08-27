// ISSUES #1 — This MUST stay the first import.
// ES module imports are hoisted and evaluated before the importing module's body,
// so loading env inside the body (the previous `dotenv.config()` call) ran *after*
// app.js and every service had already read process.env. Importing the config
// module first makes the load a hoisted side effect that genuinely happens first.
import env from "./src/config/env.js";

import app from "./app.js";
import prisma from "./src/db/prisma.js";
import { startExpiryCron, stopExpiryCron } from "./src/services/notification.service.js";

let server;

async function startServer() {
  try {
    await prisma.$connect();
    console.log("✅ Connected to PostgreSQL via Prisma");

    startExpiryCron();

    server = app.listen(env.port, () => {
      console.log(`🚀 Server is running on http://localhost:${env.port}`);
    });
  } catch (err) {
    console.error("❌ Failed to connect to the database:", err);
    process.exit(1);
  }
}

/** Close the HTTP server and database pool before exiting. */
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  stopExpiryCron();

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  await prisma.$disconnect();
  console.log("👋 Shutdown complete");
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal).catch((err) => {
      console.error("Error during shutdown:", err);
      process.exit(1);
    });
  });
}

// A rejected promise that nobody handled is a bug — log it loudly rather than
// letting Node terminate the process with no context.
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled promise rejection:", reason);
});

startServer();
