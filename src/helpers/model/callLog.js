const isValidPhone = (phone) => {
  const regExp = /^[0-9+\-().\s]{7,20}$/;
  return regExp.test(phone);
};

const isValidDirection = (direction) => {
  const validDirections = ["inbound", "outbound"];
  return validDirections.includes(direction);
};

const isValidStatus = (status) => {
  const validStatuses = [
    "answered",
    "missed",
    "voicemail",
    "failed",
    "busy",
    "no_answer",
  ];

  return validStatuses.includes(status);
};

export { isValidPhone, isValidDirection, isValidStatus };
