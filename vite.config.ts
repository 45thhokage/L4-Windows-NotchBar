import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed port and shouldn't watch the Rust files.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    // 5173 sits inside a Hyper-V/WSL excluded port range on this machine
    // (EACCES on listen); 1420 is outside all exclusions. Keep in sync with
    // src-tauri/tauri.conf.json devUrl.
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
