import { loadAccessToken } from "../lib/config.js";
import { deviceAuthFlow } from "../lib/auth.js";
import { printError, printInfo, printSuccess } from "../lib/output.js";

interface LoginArgs {
  status?: boolean;
}

export async function loginCommand(args: LoginArgs): Promise<number> {
  if (args.status) {
    const token = await loadAccessToken();
    if (token) {
      printSuccess("Logged in.", { force: true });
      return 0;
    }
    printInfo("Not logged in. Run `npx vent-hq login`.", { force: true });
    return 1;
  }

  const result = await deviceAuthFlow();
  if (result.ok) {
    printSuccess("Logged in! Vent credentials saved to ~/.vent/credentials", { force: true });
    return 0;
  }
  printError(result.error);
  return 1;
}
