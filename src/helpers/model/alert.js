const validTypes = [
  "hot_lead",
  "missed_call",
  "customer_reply",
  "booked_job",
  "system",
];

const validChannels = ["in_app", "email", "sms"];
const validStatuses = ["pending", "sent", "failed", "read"];
const validPriorities = ["low", "medium", "high"];

const isValidAlertType = (type) => validTypes.includes(type);

const isValidAlertChannel = (channel) => validChannels.includes(channel);

const isValidAlertStatus = (status) => validStatuses.includes(status);

const isValidAlertPriority = (priority) => validPriorities.includes(priority);

export {
  isValidAlertType,
  isValidAlertChannel,
  isValidAlertStatus,
  isValidAlertPriority,
};
