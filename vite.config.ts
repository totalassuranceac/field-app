import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: ".",
  publicDir: "public",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    // Smaller first paint on phones — vendor + heavy pages split out
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react-dom") || id.includes("react-router") || id.includes("/react/")) {
              return "react-vendor";
            }
            if (id.includes("xlsx")) return "xlsx";
            return "vendor";
          }
          // Heavy pages as their own chunks (loaded on navigation)
          if (id.includes("/src/pages/InventoryPage")) return "page-inventory";
          if (id.includes("/src/pages/LiveMapPage")) return "page-live";
          if (id.includes("/src/pages/AdminPage")) return "page-admin";
          if (id.includes("/src/pages/IssuesPage")) return "page-issues";
          if (id.includes("/src/receiptOcr")) return "ocr";
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
