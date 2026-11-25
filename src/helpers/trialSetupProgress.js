export const TRIAL_SETUP_STEPS = ["details", "timezone", "message", "activate", "test"];

export const trialSetupDestination = (business) => {
  const savedStep = business?.setupProgress?.currentStep;
  // Older accounts have settings but no saved wizard step.
  const step = TRIAL_SETUP_STEPS.includes(savedStep)
    ? savedStep
    : business?.forwardingPhone ? "activate" : "details";
  return `/setup?step=${step}`;
};
