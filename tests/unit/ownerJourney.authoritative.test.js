import {
  OWNER_INTERVENTION_TYPES,
  nextActionFor,
} from "../../src/services/ownerExperience.service.js";
import {
  INTERVENTION_TYPES,
} from "../../src/controllers/intervention.js";

describe("authoritative owner journey", () => {
  const baseEvidence = {
    stage: "not_started",
    humanTakeover: false,
    lastError: "",
    customerAvailabilityCaptured: true,
    serviceCaptured: true,
    addressCaptured: true,
  };

  test("ready-to-schedule is a normal workflow state, not Needs Attention", () => {
    const action = nextActionFor({
      business: { features: { aiBookingEnabled: false } },
      lead: {
        status: "contacted",
        serviceNeeded: "Drain cleaning",
        address: "970 Sidney Marcus Blvd",
        preferredAppointmentTime: "Monday",
      },
      conversation: null,
      appointment: null,
      evidence: baseEvidence,
      hasOpenIntervention: false,
    });

    expect(action).toMatchObject({
      kind: "schedule",
      label: "Ready to schedule",
      requiresOwner: false,
      actionRequired: true,
    });
  });

  test("high-value opportunities remain business context, not exceptions", () => {
    expect(OWNER_INTERVENTION_TYPES).not.toContain("high_value_lead");
    expect(INTERVENTION_TYPES).not.toContain("high_value_lead");
  });

  test("genuine exception still wins over scheduling readiness", () => {
    const action = nextActionFor({
      business: { features: { aiBookingEnabled: false } },
      lead: { status: "contacted" },
      conversation: null,
      appointment: null,
      evidence: baseEvidence,
      hasOpenIntervention: true,
    });

    expect(action).toMatchObject({
      kind: "exception",
      requiresOwner: true,
      actionRequired: true,
    });
  });

  test("confirmed appointment becomes the operational source of truth", () => {
    const action = nextActionFor({
      business: { features: { aiBookingEnabled: false } },
      lead: { status: "booked" },
      conversation: null,
      appointment: { status: "confirmed" },
      evidence: baseEvidence,
      hasOpenIntervention: false,
    });

    expect(action).toMatchObject({
      kind: "appointment",
      label: "Appointment confirmed",
      requiresOwner: false,
      actionRequired: false,
    });
  });

  test("held approval remains in Appointments instead of Needs Attention", () => {
    const action = nextActionFor({
      business: { features: { aiBookingEnabled: true } },
      lead: { status: "contacted" },
      conversation: null,
      appointment: {
        status: "held",
        requiresBusinessApproval: true,
      },
      evidence: baseEvidence,
      hasOpenIntervention: false,
    });

    expect(action).toMatchObject({
      kind: "approval",
      requiresOwner: false,
      actionRequired: true,
    });
  });
});
