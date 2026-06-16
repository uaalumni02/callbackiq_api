const isValidAlertType = (type) => {
  const validTypes = ["hot_lead", "missed_call", "booked_job", "system"];
  return validTypes.includes(type);
};

const isValidAlertChannel = (channel) => {
  const validChannels = ["in_app", "email", "sms"];
  return validChannels.includes(channel);
};

const isValidAlertStatus = (status) => {
  const validStatuses = ["pending", "sent", "failed", "read"];
  return validStatuses.includes(status);
};

const isValidAlertPriority = (priority) => {
  const validPriorities = ["low", "medium", "high"];
  return validPriorities.includes(priority);
};

export {
  isValidAlertType,
  isValidAlertChannel,
  isValidAlertStatus,
  isValidAlertPriority,
};
