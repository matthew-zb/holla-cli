import { defineCommand } from "citty";
import { storeBrowserCredentials } from "../../../lib/credentials.ts";
import { handleError } from "../../../lib/errors.ts";
import { commonArgs } from "../../../lib/args.ts";
import { readSlackDesktopCredentials } from "../later/desktop.ts";

export const browserCommand = defineCommand({
  meta: { name: "browser", description: "Store browser session credentials for Later API (auto-reads from Slack desktop app)" },
  args: {
    ...commonArgs,
    token: {
      type: "string",
      description: "Browser session token (xoxc-...) — auto-detected if omitted",
    },
    cookie: {
      type: "string",
      description: "Browser session cookie (xoxd-...) — auto-detected if omitted",
    },
  },
  async run({ args }) {
    try {
      if (!args.workspace) {
        console.error("\x1b[31m✗\x1b[0m --workspace is required");
        process.exit(1);
      }

      let xoxc = args.token;
      let xoxd = args.cookie;

      if (!xoxc || !xoxd) {
        console.log("Auto-detecting credentials from Slack desktop app...");
        const desktop = await readSlackDesktopCredentials(args.workspace);
        if (!desktop) {
          console.error(
            "\x1b[31m✗\x1b[0m Could not auto-read from Slack desktop app.\n" +
            "  Make sure Slack is installed and you are logged in.\n" +
            "  Or provide credentials manually: --token xoxc-... --cookie xoxd-...",
          );
          process.exit(1);
        }
        xoxc = xoxc ?? desktop.xoxc;
        xoxd = xoxd ?? desktop.xoxd;
        console.log(`  Found xoxc: ${xoxc.slice(0, 20)}...`);
        console.log(`  Found xoxd: ${xoxd.slice(0, 20)}...`);
      } else {
        if (!xoxc.startsWith("xoxc-")) {
          console.error("\x1b[31m✗\x1b[0m Token must start with xoxc-");
          process.exit(1);
        }
        if (!xoxd.startsWith("xoxd-")) {
          console.error("\x1b[31m✗\x1b[0m Cookie must start with xoxd-");
          process.exit(1);
        }
      }

      await storeBrowserCredentials(args.workspace, xoxc, xoxd);
      console.log(`\x1b[32m✓\x1b[0m Browser credentials saved for "${args.workspace}"`);
    } catch (error) {
      handleError(error);
    }
  },
});
