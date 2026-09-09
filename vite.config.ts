import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
	plugins: [react(), tailwind()],
	resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
	build: { outDir: "dist/client", emptyOutDir: true },
	server: {
		proxy: { "/api": "http://127.0.0.1:8787" },
	},
});
