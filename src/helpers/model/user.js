import { passwordPolicyError } from '../../services/security/passwordPolicy.js';
const isValidUserName = (userName) => {
  const regExp = /^[A-Za-z0-9]+([,'\-.]?[ ]?[A-Za-z0-9]+)*$/;
  return regExp.test(userName);
};

const isValidPassword = password => !passwordPolicyError(password);

const isValidEmail = (email) => {
  const regExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regExp.test(email);
};

const isValidRole = (role) => {
  const validRoles = ["owner", "admin", "member"];
  return validRoles.includes(role);
};

export { isValidUserName, isValidPassword, isValidEmail, isValidRole };
