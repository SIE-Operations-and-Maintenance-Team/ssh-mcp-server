import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 55174,
    proxy: {
      "/admin/api": "http://127.0.0.1:61823",
      "/mcp": "http://127.0.0.1:61823"
    }
  },
  build: { outDir: "dist", emptyOutDir: true }
});
