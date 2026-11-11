import { deleteCredentials } from "../lib/config.js";
import { printSuccess } from "../lib/output.js";

export async function logoutCommand(): Promise<number> {
  await deleteCredentials();
  printSuccess("Logged out. Credentials removed from ~/.vent/credentials", { force: true });
  return 0;
}
