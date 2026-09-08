import { invoke } from "@tauri-apps/api/core";

/** Which Help link to open. The backend holds the URL; the webview only ever names the place. */
export type HelpLink = "website" | "bugs";

/**
 * Open one of the Help links in the user's default browser. The backend maps the key to a constant
 * URL and logs it, so no URL leaves the webview. See help-menu-tasks.md.
 */
export async function openHelpLink(which: HelpLink): Promise<void> {
  await invoke("open_help_link", { which });
}
