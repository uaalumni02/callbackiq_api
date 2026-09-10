import { BUSINESS_TYPES } from "../businessTypes.js";
const isValidBusinessType = (businessType) => {
  return BUSINESS_TYPES.includes(businessType);
};

const isValidPhone = (phone) => {
  if (!phone) return true;

  const regExp = /^[0-9+\-().\s]{7,20}$/;
  return regExp.test(phone);
};

const isValidEmail = (email) => {
  if (!email) return true;

  const regExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regExp.test(email);
};

export { isValidBusinessType, isValidPhone, isValidEmail };
