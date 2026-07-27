import ExternalRecordMapping from "../../models/externalRecordMapping.js";
import SchedulingProvider from "./schedulingProvider.js";
import { generateInternalSlots } from "../../services/scheduling/slotGenerator.service.js";
import {
  assertNoJobberUserErrors,
  getJobberConnection,
  jobberGraphqlRequest,
} from "../../services/integrations/jobberConnection.service.js";

/*
 * Jobber's approved scopes and account schema determine which request/job/visit
 * mutations are available. The adapter accepts reviewed GraphQL operation
 * templates through IntegrationConnection.metadata. This keeps Jobber object
 * names out of the rest of CallBackIQ and prevents hard-coding an unapproved
 * mutation into the SMS workflow.
 */
const requireOperation = async (businessId, operationKey) => {
  const connection = await getJobberConnection(businessId);
  const operation = connection?.metadata?.operations?.[operationKey];

  if (!operation?.query || !operation?.resultPath) {
    const error = new Error(
      `Jobber ${operationKey} is not configured for this account. Save a reviewed mutation template in IntegrationConnection.metadata.operations.${operationKey}.`,
    );
    error.statusCode = 409;
    error.code = "JOBBER_OPERATION_NOT_CONFIGURED";
    throw error;
  }

  return operation;
};

const getAtPath = (value, path) =>
  String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => current?.[key], value);

class JobberProvider extends SchedulingProvider {
  async getAvailability(options) {
    /* CallBackIQ rules remain authoritative until a Jobber availability query is configured. */
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

    if (!externalId) {
      throw new Error("Jobber returned no external appointment ID.");
    }

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
    const { result } = await this.runMutation({
      operationKey: "cancelAppointment",
      variables: { input: { id: appointment.externalAppointmentId } },
    });
    return { canceled: true, raw: result };
  }

  async getAppointment({ appointment }) {
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
