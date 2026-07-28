import Appointment from "../../models/appointment.js";
import ExternalRecordMapping from "../../models/externalRecordMapping.js";
import IntegrationConnection from "../../models/integrationConnection.js";
import Lead from "../../models/lead.js";
import ServiceOffering from "../../models/serviceOffering.js";
import {
  assertNoJobberUserErrors,
  jobberGraphqlRequest,
} from "./jobberConnection.service.js";
import { getJobberSettings } from "./integrationSettings.service.js";

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");
const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const splitName = (value) => {
  const parts = String(value || "Customer").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "Customer",
    lastName: parts.slice(1).join(" ") || "Lead",
  };
};
const getAtPath = (value, path) =>
  String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => current?.[key], value);

const builtInOperations = {
  listClients: {
    query: `query CallBackIQClients($after: String) {
      clients(first: 100, after: $after) {
        nodes {
          id
          firstName
          lastName
          companyName
          emails { address primary }
          phones { number primary }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    resultPath: "clients",
  },
  createClient: {
    query: `mutation CallBackIQClientCreate($input: ClientCreateInput!) {
      clientCreate(input: $input) {
        client { id firstName lastName companyName }
        userErrors { message path }
      }
    }`,
    resultPath: "clientCreate",
    externalIdPath: "client.id",
  },
  updateClient: {
    query: `mutation CallBackIQClientEdit($input: ClientEditInput!) {
      clientEdit(input: $input) {
        client { id firstName lastName companyName }
        userErrors { message path }
      }
    }`,
    resultPath: "clientEdit",
    externalIdPath: "client.id",
  },
  createRequest: {
    query: `mutation CallBackIQRequestCreate($input: RequestCreateInput!) {
      requestCreate(input: $input) {
        request { id title }
        userErrors { message path }
      }
    }`,
    resultPath: "requestCreate",
    externalIdPath: "request.id",
  },
};

const resolveOperation = (connection, key) => ({
  ...builtInOperations[key],
  ...(connection?.metadata?.operations?.[key] || {}),
});

const executeOperation = async ({ businessId, connection, key, variables }) => {
  const operation = resolveOperation(connection, key);
  if (!operation?.query || !operation?.resultPath) {
    const error = new Error(`Jobber operation ${key} is not configured.`);
    error.statusCode = 409;
    error.code = "JOBBER_OPERATION_NOT_CONFIGURED";
    throw error;
  }
  const data = await jobberGraphqlRequest({
    businessId,
    query: operation.query,
    variables,
  });
  const result = getAtPath(data, operation.resultPath);
  if (key !== "listClients") assertNoJobberUserErrors(result, key);
  return { result, operation };
};

const findExistingClient = async ({ businessId, connection, phone, email }) => {
  let after = null;
  let pages = 0;
  do {
    const { result } = await executeOperation({
      businessId,
      connection,
      key: "listClients",
      variables: { after },
    });
    const match = (result?.nodes || []).find((client) => {
      const phones = (client.phones || []).map((item) => normalizePhone(item.number));
      const emails = (client.emails || []).map((item) => normalizeEmail(item.address));
      return (
        (phone && phones.includes(normalizePhone(phone))) ||
        (email && emails.includes(normalizeEmail(email)))
      );
    });
    if (match) return match;
    after = result?.pageInfo?.hasNextPage ? result.pageInfo.endCursor : null;
    pages += 1;
  } while (after && pages < 10);
  return null;
};

const clientInput = ({ lead, existingId }) => {
  const { firstName, lastName } = splitName(lead.customerName || lead.name);
  const input = {
    ...(existingId ? { id: existingId } : {}),
    firstName,
    lastName,
  };
  if (lead.email) {
    input.emails = [{ description: "MAIN", primary: true, address: lead.email }];
  }
  if (lead.phone) {
    input.phones = [{ description: "MAIN", primary: true, number: lead.phone }];
  }
  return input;
};

const render = (template, values) =>
  String(template || "").replace(/{{\s*(\w+)\s*}}/g, (_, key) => values[key] || "");

const requestDetails = ({ lead, service, settings }) =>
  [
    settings.defaultRequestDetails,
    `CallBackIQ lead: ${lead._id}`,
    `Customer: ${lead.customerName || lead.name || "Customer"}`,
    `Phone: ${lead.phone || ""}`,
    `Email: ${lead.email || ""}`,
    `Service: ${service?.name || lead.serviceNeeded || "Service requested"}`,
    `Urgency: ${lead.urgency || "unknown"}`,
    `Preferred time: ${lead.preferredAppointmentTime || "Not provided"}`,
    `Address: ${lead.address || "Not provided"}`,
    lead.summary ? `AI summary: ${lead.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");

export const ensureJobberClientForLead = async ({ lead, connection }) => {
  const businessId = lead.business;
  const existingMapping = await ExternalRecordMapping.findOne({
    business: businessId,
    provider: "jobber",
    localModel: "Lead",
    localId: lead._id,
    externalType: "client",
    syncStatus: "synced",
  });
  if (existingMapping) return existingMapping.externalId;

  const settings = getJobberSettings(connection);
  const existing = await findExistingClient({
    businessId,
    connection,
    phone: lead.phone,
    email: lead.email,
  });
  let externalId = existing?.id;
  if (existing && settings.updateExistingClients) {
    const { result, operation } = await executeOperation({
      businessId,
      connection,
      key: "updateClient",
      variables: { input: clientInput({ lead, existingId: existing.id }) },
    });
    externalId = getAtPath(result, operation.externalIdPath || "client.id") || existing.id;
  } else if (!existing) {
    if (!settings.createClientWhenMissing) {
      const error = new Error("No matching Jobber client was found.");
      error.statusCode = 409;
      error.code = "JOBBER_CLIENT_NOT_FOUND";
      throw error;
    }
    const { result, operation } = await executeOperation({
      businessId,
      connection,
      key: "createClient",
      variables: { input: clientInput({ lead }) },
    });
    externalId = getAtPath(result, operation.externalIdPath || "client.id");
  }
  if (!externalId) throw new Error("Jobber returned no client ID.");

  await ExternalRecordMapping.findOneAndUpdate(
    {
      business: businessId,
      provider: "jobber",
      localModel: "Lead",
      localId: lead._id,
      externalType: "client",
    },
    {
      $set: {
        externalId: String(externalId),
        syncStatus: "synced",
        syncError: "",
        lastSyncedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );
  return String(externalId);
};

export const syncLeadToJobber = async ({ businessId, leadId }) => {
  const [connection, lead] = await Promise.all([
    IntegrationConnection.findOne({ business: businessId, provider: "jobber" }),
    Lead.findOne({ _id: leadId, business: businessId }),
  ]);
  if (!connection || connection.status !== "connected") {
    const error = new Error("Jobber is not connected.");
    error.statusCode = 409;
    throw error;
  }
  if (!lead) {
    const error = new Error("Lead not found.");
    error.statusCode = 404;
    throw error;
  }
  const existingRequest = await ExternalRecordMapping.findOne({
    business: businessId,
    provider: "jobber",
    localModel: "Lead",
    localId: lead._id,
    externalType: "request",
    syncStatus: "synced",
  });
  if (existingRequest) {
    return { clientId: existingRequest.metadata?.clientId || "", requestId: existingRequest.externalId, duplicate: true };
  }

  const clientId = await ensureJobberClientForLead({ lead, connection });
  const serviceNameKey = String(lead.serviceNeeded || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const service = serviceNameKey
    ? await ServiceOffering.findOne({ business: businessId, nameKey: serviceNameKey })
    : null;
  const settings = getJobberSettings(connection);
  const values = {
    service: service?.name || lead.serviceNeeded || "Service request",
    customer: lead.customerName || lead.name || "Customer",
    urgency: lead.urgency || "",
  };
  const input = {
    clientId,
    title: render(settings.requestTitleTemplate, values),
    details: requestDetails({ lead, service, settings }),
  };
  const operationOverride = connection.metadata?.operations?.createRequest;
  if (operationOverride?.inputBuilder === "property") {
    input.propertyId = operationOverride.propertyId || undefined;
  }
  const { result, operation } = await executeOperation({
    businessId,
    connection,
    key: "createRequest",
    variables: { input },
  });
  const requestId = getAtPath(result, operation.externalIdPath || "request.id");
  if (!requestId) throw new Error("Jobber returned no request ID.");

  await ExternalRecordMapping.findOneAndUpdate(
    {
      business: businessId,
      provider: "jobber",
      localModel: "Lead",
      localId: lead._id,
      externalType: "request",
    },
    {
      $set: {
        externalId: String(requestId),
        syncStatus: "synced",
        syncError: "",
        lastSyncedAt: new Date(),
        metadata: { clientId },
      },
    },
    { upsert: true, new: true },
  );
  return { clientId, requestId: String(requestId), duplicate: false };
};

export const syncPendingQualifiedLeadsToJobber = async ({ businessId, limit = 25 }) => {
  const connection = await IntegrationConnection.findOne({
    business: businessId,
    provider: "jobber",
    status: "connected",
  });
  const settings = getJobberSettings(connection);
  if (!connection || !settings.syncQualifiedLeads) return [];
  const mapped = await ExternalRecordMapping.distinct("localId", {
    business: businessId,
    provider: "jobber",
    localModel: "Lead",
    externalType: "request",
    syncStatus: "synced",
  });
  let candidateFilter;
  if (settings.createRequestOn === "confirmed_appointment") {
    const confirmedLeadIds = await Appointment.distinct("lead", {
      business: businessId,
      status: "confirmed",
      lead: { $ne: null },
    });
    candidateFilter = {
      _id: { $in: confirmedLeadIds, $nin: mapped },
      status: { $nin: ["lost", "spam"] },
    };
  } else {
    candidateFilter = {
      _id: { $nin: mapped },
      status: { $nin: ["lost", "spam"] },
      $or: [
        { qualifiedAt: { $ne: null } },
        { leadQualityScore: { $gte: settings.minimumLeadQualityScore } },
        { status: { $in: ["contacted", "booked"] } },
      ],
    };
  }

  const leads = await Lead.find({
    business: businessId,
    ...candidateFilter,
  })
    .sort({ createdAt: 1 })
    .limit(Math.min(Number(limit) || 25, 100));
  const results = [];
  for (const lead of leads) {
    try {
      results.push({ leadId: String(lead._id), ...(await syncLeadToJobber({ businessId, leadId: lead._id })) });
    } catch (error) {
      results.push({ leadId: String(lead._id), error: error.message });
    }
  }
  return results;
};
