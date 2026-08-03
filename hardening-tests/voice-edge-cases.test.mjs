import test from "node:test";
import assert from "node:assert/strict";

import {
  extractPostalCode,
  isBusinessHoursQuestion,
  isCallbackRequest,
  isCancelIntent,
  isLikelyNonEnglish,
  isRepeatIntent,
  isServiceAreaQuestion,
  isSkipIntent,
  parseCorrection,
  sanitizeDtmfDigits,
} from "../src/voice/voiceInput.service.js";
import {
  timeToMinutes,
  windowKind,
  withinTimeWindow,
} from "../src/voice/voiceTimeWindow.service.js";

const overnight = { startTime: "20:00", endTime: "02:00" };

test("overnight and all-day windows honor exact boundaries", () => {
  assert.equal(windowKind(overnight), "overnight");
  assert.equal(withinTimeWindow("23:00", overnight), true);
  assert.equal(
    withinTimeWindow("01:00", overnight, { previousDaySpillover: true }),
    true,
  );
  assert.equal(
    withinTimeWindow("03:00", overnight, { previousDaySpillover: true }),
    false,
  );
  assert.equal(
    withinTimeWindow("12:00", { startTime: "00:00", endTime: "24:00" }),
    true,
  );
  assert.equal(
    withinTimeWindow("12:00", { startTime: "08:00", endTime: "08:00" }),
    false,
  );
  assert.equal(timeToMinutes("24:00"), 1440);
});

test("hours intent does not hijack open-drain or closed-valve service wording", () => {
  assert.equal(isBusinessHoursQuestion("Can you open my drain?"), false);
  assert.equal(isBusinessHoursQuestion("The valve will not close"), false);
  assert.equal(isBusinessHoursQuestion("What time do you close today?"), true);
});

test("service-area questions and spoken ZIPs are normalized independently", () => {
  assert.equal(isServiceAreaQuestion("Do you serve my area?"), true);
  assert.equal(extractPostalCode("Do you serve my area?"), "");
  assert.equal(extractPostalCode("My ZIP is 3 0 3 0 2"), "30302");
  assert.equal(extractPostalCode("three oh three oh two"), "30302");
});

test("callback intent is forward-looking and ignores call-history wording", () => {
  assert.equal(isCallbackRequest("Please have the team call me back"), true);
  assert.equal(isCallbackRequest("I called back because no one answered"), false);
});

test("capture escape hatches recognize natural caller wording", () => {
  assert.equal(isCancelIntent("Actually, never mind. Cancel that."), true);
  assert.equal(isSkipIntent("You can skip that one"), true);
  assert.equal(isRepeatIntent("Sorry, what did you say?"), true);
  assert.deepEqual(parseCorrection("No, I meant my ZIP is 30303"), {
    field: "location",
    value: "30303",
  });
});

test("language barrier detection handles ASCII Spanish and explicit requests", () => {
  assert.equal(isLikelyNonEnglish("Necesito un plomero"), true);
  assert.equal(isLikelyNonEnglish("I need a Spanish interpreter"), true);
  assert.equal(isLikelyNonEnglish("I need a plumber for a leak"), false);
});

test("DTMF sanitation keeps only bounded digits", () => {
  assert.equal(sanitizeDtmfDigits("1-2-3#*456"), "123456");
  assert.equal(sanitizeDtmfDigits("123456789012345678901234"), "12345678901234567890");
});
