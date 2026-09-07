import SocketService from "../../services/socket.service.js";

export const installAccessRevocation = (schema, kind) => {
  const fields = kind === "user" ? ["role", "sessionVersion", "password"] : ["owner", "isActive"];
  const changed = update => Array.isArray(update) || fields.some(field =>
    [update, update?.$set, update?.$inc, update?.$unset].some(part => part && Object.hasOwn(part, field)));
  const disconnect = id => {
    const io = SocketService.getIo?.();
    if (!io) return;
    // Redis adapter propagates this control operation to every API instance.
    if (id && (typeof id === "string" || typeof id?.toHexString === "function")) io.in(`${kind}:${id}`).disconnectSockets(true);
    else io.disconnectSockets(true); // Bulk access changes revoke all sessions.
  };
  schema.pre("save", function () { this.$locals.revokeAccess = !this.isNew && fields.some(f => this.isModified(f)); });
  schema.post("save", function (doc) { if (doc.$locals.revokeAccess) disconnect(doc._id); });
  for (const operation of ["findOneAndUpdate", "updateOne", "updateMany", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"]) {
    schema.post(operation, function (result) {
      if (/delete|replace/i.test(operation) || changed(this.getUpdate())) disconnect(result?._id || this.getFilter()?._id);
    });
  }
};
