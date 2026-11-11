import { exec } from "node:child_process";

export function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    // Open URL in background — open -g works for Safari/Firefox,
    // Chromium browsers ignore it but it's the best we can do without
    // System Events permissions
    exec(`open -g "${url}"`);
  } else if (process.platform === "win32") {
    exec(`start "" "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}
