import { createApp } from "./app.js";
import { env } from "./env.js";
import { createRealtimeServer } from "./realtime/index.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`kelola-api listening on http://localhost:${env.PORT}`);
});

// app.listen returns the http.Server, so Socket.io shares the same port.
const io = createRealtimeServer(server);

function shutdown(signal: string) {
  console.log(`${signal} received, closing server`);

  // Close sockets first: open connections would otherwise keep the HTTP server
  // alive and the process would hang instead of exiting.
  void io.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
