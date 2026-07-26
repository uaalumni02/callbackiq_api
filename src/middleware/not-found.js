const notFound = (req, res) => {
  return res.status(404).json({
    success: false,
    message: "Route not found",
    requestId: req.context?.requestId || "",
  });
};

export default notFound;
