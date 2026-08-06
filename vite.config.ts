import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    // The app's CSP (default-src 'self') disallows data: URIs. Without this, Vite
    // inlines small files (such as the less-used font subsets) as base64 straight into
    // the CSS, and the browser blocks that load. Setting the limit to 0 makes every
    // file a real physical asset served from 'self' — no conflict with the CSP.
    assetsInlineLimit: 0
  }
});