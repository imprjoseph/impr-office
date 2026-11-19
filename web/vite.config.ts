import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" 讓建置結果放在 GitHub Pages 的子路徑（/impr-office/）也能載入。
// 本機開發時 CSP 另外允許連到 localhost 的模擬後端（gas/test/dev-server.js）；正式建置不含這一條。
export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: "dev-csp",
    transformIndexHtml: (html: string) => command === "serve"
      ? html.replace("connect-src ", "connect-src http://localhost:8795 ws://localhost:5180 ").replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      : html,
  }],
  base: "./",
}));
