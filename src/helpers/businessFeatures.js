const BUSINESS_FEATURE_DEFAULTS = Object.freeze({
  missedCallSmsEnabled: true,
  aiQualificationEnabled: true,
  aiBookingEnabled: false,
  automatedFollowUpEnabled: false,
  voiceAiEnabled: false,
  revenueTrackingEnabled: false,
  calendarProvider: "internal",
});

const toPlainObject = (value) => {
  if (!value) {
    return {};
  }

  if (typeof value.toObject === "function") {
    return value.toObject();
  }

  return value;
};

export const getBusinessFeatures = (business) => {
  const businessObject = toPlainObject(business);
  const features = toPlainObject(businessObject.features);

  return {
    ...BUSINESS_FEATURE_DEFAULTS,
    ...features,
  };
};

export const isBusinessFeatureEnabled = (business, featureName) => {
  const features = getBusinessFeatures(business);

  return features[featureName] === true;
};

export const getBusinessCalendarProvider = (business) => {
  return getBusinessFeatures(business).calendarProvider;
};

export { BUSINESS_FEATURE_DEFAULTS };
