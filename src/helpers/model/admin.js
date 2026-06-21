export const isAdminUser = (user = {}) => {
  return String(user?.role || "").toLowerCase() === "admin";
};

export const cleanAdminUser = (user = {}) => ({
  _id: user._id,
  userName: user.userName,
  email: user.email,
  role: user.role,
  businessName: user.businessName,
  businessPhone: user.businessPhone,
  businessType: user.businessType,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

export const formatCustomerRow = ({
  business,
  owner,
  subscription,
  leadCount = 0,
  callCount = 0,
  missedCallCount = 0,
  conversationCount = 0,
  messageCount = 0,
}) => ({
  business: {
    _id: business._id,
    businessName: business.businessName,
    businessType: business.businessType,
    phone: business.phone,
    email: business.email,
    city: business.city,
    state: business.state,
    estimatedJobValue: business.estimatedJobValue,
    isActive: business.isActive,
    createdAt: business.createdAt,
    updatedAt: business.updatedAt,
  },
  owner: owner ? cleanAdminUser(owner) : null,
  subscription: subscription || {
    plan: "none",
    status: "none",
    aiEnabled: false,
  },
  counts: {
    leads: leadCount,
    calls: callCount,
    missedCalls: missedCallCount,
    conversations: conversationCount,
    messages: messageCount,
  },
});
