const isValidDirection = (direction) => {
  const validDirections = ["inbound", "outbound"];
  return validDirections.includes(direction);
};

const isValidPhone = (phone) => {
  const regExp = /^[0-9+\-().\s]{7,20}$/;
  return regExp.test(phone);
};

export { isValidDirection, isValidPhone };
