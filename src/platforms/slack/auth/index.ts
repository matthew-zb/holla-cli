import { defineCommand } from "citty";
import { loginCommand } from "./login.ts";
import { logoutCommand } from "./logout.ts";
import { statusCommand } from "./status.ts";
import { whoamiCommand } from "./whoami.ts";
import { browserCommand } from "./browser.ts";

export const authCommand = defineCommand({
  meta: { name: "auth", description: "Manage Slack authentication" },
  subCommands: {
    login: loginCommand,
    logout: logoutCommand,
    status: statusCommand,
    whoami: whoamiCommand,
    browser: browserCommand,
  },
});
