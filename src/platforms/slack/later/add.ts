import { defineCommand } from "citty";
import { getBrowserCredentials } from "../../../lib/credentials.ts";
import { handleError } from "../../../lib/errors.ts";
import { commonArgs } from "../../../lib/args.ts";
import { callSavedApi } from "./list.ts";

export const addCommand = defineCommand({
  meta: { name: "add", description: "Add a message to Later (save for later)" },
  args: {
    ...commonArgs,
    "item-id": {
      type: "string",
      description: "Channel ID or item ID",
      required: true,
    },
    ts: {
      type: "string",
      description: "Message timestamp",
      required: true,
    },
  },
  async run({ args }) {
    try {
      const { browserToken, browserCookie, workspace } = await getBrowserCredentials(args.workspace);

      await callSavedApi(workspace, "saved.add", browserToken, browserCookie, {
        item_type: "message",
        item_id: args["item-id"],
        ts: args.ts,
      });

      console.log(`\x1b[32m✓\x1b[0m Added to Later`);
    } catch (error) {
      handleError(error);
    }
  },
});
