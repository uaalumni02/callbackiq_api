import { isCancelIntent } from "../../src/voice/voiceInput.service.js";
import { isRequestWithdrawal } from "../../src/services/conversationControlPolicy.js";
import { planCustomerTurn } from "../../src/services/messaging/customerTurnPlan.service.js";
import { classifySmsIntent } from "../../src/services/messaging/smsIntentClassifier.service.js";
test.each([
  "I need a non-stop dripping faucet repaired",
  "The AC runs non-stop",
  "I do not want to cancel my appointment",
  "Do not cancel my appointment; the address is 123 Test St",
  "What if I cancel my appointment?",
])("B05/M02 a mention is not withdrawal: %s", (text) => {
  expect(isCancelIntent(text)).toBe(false);
  expect(isRequestWithdrawal(text)).toBe(false);
  expect(
    planCustomerTurn({
      customerMessage: text,
      business: {},
      lead: {},
      conversation: {},
    }).withdrawal,
  ).toBe(false);
  expect(classifySmsIntent({ customerMessage: text }).intents.cancel).toBe(
    false,
  );
});
test.each([
  "Cancel my appointment",
  "Please cancel my request",
  "Never mind",
  "Cancel",
])("B05/M02 explicit withdrawal remains available: %s", (text) => {
  expect(isRequestWithdrawal(text)).toBe(true);
  expect(isCancelIntent(text)).toBe(true);
});

test("M02 negated cancellation retains an additional service rather than suppressing compound facts", () => {
  const plan = planCustomerTurn({
    customerMessage: "Do not cancel my appointment; I also need faucet repair",
    business: {},
    lead: { serviceNeeded: "AC repair" },
    conversation: {},
  });
  expect(plan.withdrawal).toBe(false);
  expect(plan.classified.intents.cancel).toBe(false);
  expect(plan.additionalRequest).toMatch(/faucet/i);
});
