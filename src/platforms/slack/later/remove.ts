import { defineCommand } from "citty";
import { getBrowserCredentials } from "../../../lib/credentials.ts";
import { handleError } from "../../../lib/errors.ts";
import { commonArgs } from "../../../lib/args.ts";
import { callSavedApi } from "./list.ts";

export const removeCommand = defineCommand({
  meta: { name: "remove", description: "Remove an item from Later (unsave)" },
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

      await callSavedApi(workspace, "saved.delete", browserToken, browserCookie, {
        item_type: "message",
        item_id: args["item-id"],
        ts: args.ts,
      });

      console.log(`\x1b[32m✓\x1b[0m Removed from Later`);
    } catch (error) {
      handleError(error);
    }
  },
});
