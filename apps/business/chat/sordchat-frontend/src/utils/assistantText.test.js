import { buildAssistantFollowUpCommand } from "./assistantText";

test("keeps a pending meeting when the user supplies a relative date", () => {
  const command = buildAssistantFollowUpCommand({
    pending: {
      intent: "meeting",
      needs_input: true,
      command: "Marcar reuniao sobre VoltChat com Leonardo",
    },
    content: "hoje",
  });

  expect(command).toContain("VoltChat");
  expect(command).toContain("hoje");
});