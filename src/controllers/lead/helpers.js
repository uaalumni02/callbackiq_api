



import Db from "../../db/db.js";
import Lead from "../../models/lead.js";
import Business from "../../models/business.js";


import AlertService from "../../services/alert.service.js";



const getBusinessForOwner = async (ownerId) => {
  return typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);
};

const updateLeadForBusiness = (id,businessId,data) => Db.updateLeadForBusiness(Lead,id,businessId,data);

const deleteLeadForBusiness = (id,businessId) => Db.deleteLeadForBusiness(Lead,id,businessId);

const isHotLead = (lead) => {
  return (
    Number(lead?.leadQualityScore || 0) >= 80 || lead?.urgency === "emergency"
  );
};

const createHotLeadAlertWhenNeeded = async ({
  businessId,
  previousLead,
  updatedLead,
}) => {
  if (!updatedLead || isHotLead(previousLead) || !isHotLead(updatedLead)) {
    return;
  }

  await AlertService.createHotLeadAlert({
    businessId,
    leadId: updatedLead._id,
    customerName: updatedLead.customerName,
    customerPhone: updatedLead.phone,
    score: updatedLead.leadQualityScore,
    urgency: updatedLead.urgency,
    serviceNeeded: updatedLead.serviceNeeded,
    estimatedValue: updatedLead.estimatedValue,
  });
};

export { getBusinessForOwner, isHotLead, createHotLeadAlertWhenNeeded, updateLeadForBusiness, deleteLeadForBusiness };
