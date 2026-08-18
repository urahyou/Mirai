import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function miraiProposalExtension(pi: ExtensionAPI) {
  let submitted = false;

  pi.registerTool({
    name: "mirai_submit_proposal",
    label: "Submit Mirai Proposal",
    description: "Submit the single final proposal for the authorized Mirai capability.",
    promptSnippet: "Submit exactly one bounded Mirai proposal as the final action",
    promptGuidelines: [
      "Use mirai_submit_proposal exactly once as the final action.",
      "The mirai_submit_proposal capability must exactly match the authorized capability in the task.",
      "Do not request or infer capabilities, secrets, files, commands, or private context absent from the task snapshot.",
    ],
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 2000 }),
      capability: Type.String({ minLength: 1, maxLength: 80 }),
      parameters: Type.Record(Type.String({ maxLength: 80 }), Type.Unknown()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      if (submitted) throw new Error("Only one Mirai proposal is allowed");
      submitted = true;
      return {
        content: [{ type: "text", text: "Proposal submitted." }],
        details: { summary: params.summary, capability: params.capability, parameters: params.parameters },
        terminate: true,
      };
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "mirai_submit_proposal") {
      return { block: true, reason: "Only the Mirai proposal tool is authorized", terminate: true };
    }
  });
}
