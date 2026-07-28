import ExternalRecordMapping from "../../models/externalRecordMapping.js";
import SchedulingProvider from "./schedulingProvider.js";
import { generateInternalSlots } from "../../services/scheduling/slotGenerator.service.js";
import {
  assertNoJobberUserErrors,
  getJobberConnection,
  jobberGraphqlRequest,
} from "../../services/integrations/jobberConnection.service.js";
import { syncLeadToJobber } from "../../services/integrations/jobberWorkflow.service.js";

const getAtPath = (value, path) =>
  String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => current?.[key], value);

const requireOperation = async (businessId, operationKey) => {
  const connection = await getJobberConnection(businessId);
  const operation = connection?.metadata?.operations?.[operationKey];
  if (!operation?.query || !operation?.resultPath) {
    const error = new Error(
      `Jobber ${operationKey} requires an approved GraphQL operation for this account. ` +
        "Lead-to-request sync works without this operation; direct visit scheduling is optional.",
    );
    error.statusCode = 409;
    error.code = "JOBBER_OPERATION_NOT_CONFIGURED";
    throw error;
  }
  return operation;
};

class JobberProvider extends SchedulingProvider {
  async getAvailability(options) {
    // CallBackIQ/Google remains the scheduling authority; Jobber receives the operational handoff.
    return generateInternalSlots({ ...options, business: this.business });
  }

  async runMutation({ operationKey, variables }) {
    const businessId = this.business._id || this.business.id;
    const operation = await requireOperation(businessId, operationKey);
    const data = await jobberGraphqlRequest({
      businessId,
      query: operation.query,
      variables,
    });
    const result = getAtPath(data, operation.resultPath);
    assertNoJobberUserErrors(result, operationKey);
    return { result, operation };
  }

  async createAppointment({ appointment, service }) {
    const businessId = this.business._id || this.business.id;
    if (appointment.lead) {
      const handoff = await syncLeadToJobber({
        businessId,
        leadId: appointment.lead,
      });
      const connection = await getJobberConnection(businessId);
      const operation = connection?.metadata?.operations?.createAppointment;
      if (!operation?.query) {
        return {
          provider: "jobber",
          externalAppointmentId: handoff.requestId,
          externalCalendarId: "jobber-request",
          raw: { handoff, schedulingAuthority: "callbackiq" },
        };
      }
    }

    const { result, operation } = await this.runMutation({
      operationKey: "createAppointment",
      variables: {
        input: {
          callbackiqAppointmentId: String(appointment._id),
          customerName: appointment.customerName,
          customerPhone: appointment.customerPhone,
          customerEmail: appointment.customerEmail,
          serviceName: service?.name || "Service appointment",
          startAt: new Date(appointment.startAt).toISOString(),
          endAt: new Date(appointment.endAt).toISOString(),
          address: appointment.address,
          notes: appointment.notes,
        },
      },
    });
    const externalId = getAtPath(result, operation.externalIdPath || "id");
    if (!externalId) throw new Error("Jobber returned no external appointment ID.");
    await ExternalRecordMapping.findOneAndUpdate(
      {
        business: this.business._id,
        provider: "jobber",
        localModel: "Appointment",
        localId: appointment._id,
        externalType: operation.externalType || "visit",
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
    return {
      provider: "jobber",
      externalAppointmentId: String(externalId),
      externalCalendarId: "jobber",
      raw: result,
    };
  }

  async updateAppointment({ appointment, changes }) {
    if (appointment.externalCalendarId === "jobber-request") {
      return {
        provider: "jobber",
        externalAppointmentId: appointment.externalAppointmentId,
        externalCalendarId: "jobber-request",
        raw: { requestOnly: true },
      };
    }
    const { result } = await this.runMutation({
      operationKey: "updateAppointment",
      variables: {
        input: {
          id: appointment.externalAppointmentId,
          startAt: new Date(changes.startAt).toISOString(),
          endAt: new Date(changes.endAt).toISOString(),
        },
      },
    });
    return {
      provider: "jobber",
      externalAppointmentId: appointment.externalAppointmentId,
      externalCalendarId: "jobber",
      raw: result,
    };
  }

  async cancelAppointment({ appointment }) {
    if (appointment.externalCalendarId === "jobber-request") {
      return { canceled: true, requestPreserved: true };
    }
    const { result } = await this.runMutation({
      operationKey: "cancelAppointment",
      variables: { input: { id: appointment.externalAppointmentId } },
    });
    return { canceled: true, raw: result };
  }

  async getAppointment({ appointment }) {
    if (appointment.externalCalendarId === "jobber-request") {
      return { id: appointment.externalAppointmentId, type: "request" };
    }
    const businessId = this.business._id || this.business.id;
    const operation = await requireOperation(businessId, "getAppointment");
    const data = await jobberGraphqlRequest({
      businessId,
      query: operation.query,
      variables: { id: appointment.externalAppointmentId },
    });
    return getAtPath(data, operation.resultPath);
  }

  async testConnection() {
    const businessId = this.business._id || this.business.id;
    const data = await jobberGraphqlRequest({
      businessId,
      query: "query CallBackIQJobberConnectionTest { account { id name } }",
    });
    return { connected: true, provider: "jobber", account: data.account };
  }
}

export default JobberProvider;
