import { defineConfig } from "vite";
import { resolve } from "path";

// Three entry points, because the app is three windows: the control panel, the transparent
// overlay that draws the ghost, and the host's aim-rect picker. They share `protocol.ts` and
// nothing else — the overlay in particular must stay tiny, it repaints at 60 Hz.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    target: "safari15",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "overlay.html"),
        aim: resolve(__dirname, "aim.html"),
      },
    },
  },
});
