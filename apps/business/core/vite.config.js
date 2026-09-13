const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");
const path = require("path");

module.exports = defineConfig({
  plugins: [react()],
  root: __dirname,
  cacheDir: path.resolve(__dirname, "../../../tmp/volt-core-vite-cache"),
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.VOLT_CORE_WEB_PORT || 5174),
    proxy: {
      "/brand/dachbyte": "http://localhost:3100",
      "/api/core": "http://localhost:3100",
      "/core": "http://localhost:3100",
      "/health": "http://localhost:3100",
      "/status": "http://localhost:3100",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/client"),
    },
  },
});
