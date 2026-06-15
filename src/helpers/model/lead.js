const isValidPhone = (phone) => {
  const regExp = /^[0-9+\-().\s]{7,20}$/;
  return regExp.test(phone);
};

const isValidEmail = (email) => {
  if (!email) return true;

  const regExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regExp.test(email);
};

const isValidUrgency = (urgency) => {
  const validUrgencies = ["low", "medium", "high", "emergency"];
  return validUrgencies.includes(urgency);
};

const isValidStatus = (status) => {
  const validStatuses = ["new", "contacted", "booked", "lost", "spam"];
  return validStatuses.includes(status);
};

export { isValidPhone, isValidEmail, isValidUrgency, isValidStatus };
