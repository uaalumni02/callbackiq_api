const responseBadRquest = (res) => {
  return res.status(400).json({
    success: false,
    message: "unable to save provided input",
  });
};

const responseNotFound = (res) => {
  return res.status(404).json({
    success: false,
    message: "Unable to show response",
  });
};

const responseOkCreated = (res, data) => {
  return res.status(201).json({
    success: true,
    message: "added",
    data,
  });
};

const responseOk = (res, data) => {
  return res.status(200).json({
    success: true,
    data,
  });
};

const responseConflict = (res) => {
  return res.status(409).json({
    success: false,
    message: "user name exist",
  });
};

const responseBadAuth = (res) => {
  return res.status(401).json({
    success: false,
    message: "auth failed",
  });
};

const responseOkUserCreated = (res, userdata) => {
  return res.status(201).json({
    success: true,
    message: "user successfully added",
    userdata,
  });
};

const responseServerError = (res) => {
  return res.status(500).json({
    success: false,
    message: "internal server error",
  });
};

const responseValidationError = (res) => {
  return res.status(400).json({
    success: false,
    message: "Validation Error, bad request",
  });
};

const responseInvalidInput = (res, message = "Invalid input provided") => {
  return res.status(400).json({
    success: false,
    message,
  });
};

const responseOkTokenCreated = (res, data) => {
  return res.status(201).json({
    success: true,
    message: "Will send reset link to email",
    data,
  });
};

const responseTokenExpired = (res) => {
  return res.status(401).json({
    success: false,
    message: "Reset token is not valid or has expired",
  });
};

const responseEmailNotFound = (res) => {
  return res.status(404).json({
    success: false,
    message: "Will send reset link to email",
  });
};

const responseInvalidConfirmation = (res) => {
  return res.status(401).json({
    success: false,
    message: "Passwords do not match ",
  });
};

const responseUserNotFound = (res) => {
  return res.status(404).json({
    success: false,
    message: "User Not Found",
  });
};

const responseOkUpdated = (res, data) => {
  return res.status(200).json({
    success: true,
    data,
    message: "Password reset successful, proceed to login",
  });
};

const responseCreated = (res, data, message = "Created successfully") => {
  return res.status(201).json({
    success: true,
    message,
    data,
  });
};

export {
  responseBadRquest,
  responseNotFound,
  responseOkCreated,
  responseOk,
  responseConflict,
  responseBadAuth,
  responseOkUserCreated,
  responseServerError,
  responseValidationError,
  responseInvalidInput,
  responseOkTokenCreated,
  responseTokenExpired,
  responseEmailNotFound,
  responseInvalidConfirmation,
  responseUserNotFound,
  responseOkUpdated,
  responseCreated
};