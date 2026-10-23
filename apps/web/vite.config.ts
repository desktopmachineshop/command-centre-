import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.CC_SERVER_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the PWA talks to a local server through the Vite proxy.
    proxy: {
      "/api": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
});
