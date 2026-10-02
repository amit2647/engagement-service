const app = require("./app");

const PORT = process.env.PORT || 4009;

async function startServer() {
  try {
    console.log("[SERVER] Starting engagement-service...");

    app.listen(PORT, () => {
      console.log(`[SERVER] Engagement service running on port ${PORT}`);
    });
  } catch (error) {
    console.error("[SERVER] Engagement service startup failed");

    console.error(error);

    process.exit(1);
  }
}

startServer();
