import {preserveHigherUrgency, VALID_URGENCIES} from "../../src/services/messaging/urgencyPolicy.service.js";
describe("SMS urgency extraction regression",()=>{
  test("preserves higher existing urgency",()=>{
    expect(preserveHigherUrgency("high","low")).toBe("high");
    expect(preserveHigherUrgency("emergency","medium")).toBe("emergency");
  });
  test("promotes true higher urgency and rejects unrecognized candidates",()=>{
    expect(preserveHigherUrgency("low","emergency")).toBe("emergency");
    expect(preserveHigherUrgency("high","unknown")).toBe("high");
    expect(VALID_URGENCIES.has("emergency")).toBe(true);
  });
});
