import User from "../models/user.js";
import Business from "../models/business.js";
import { withDeadline } from "./boundedRedis.service.js";

// One batched read per interval, rather than a database query per socket.
export const revalidateSocketSessions = async (io) => {
  const sockets = [...io.of("/").sockets.values()];
  if (!sockets.length) return;
  try {
    const users = await withDeadline(User.find({ _id: { $in: [...new Set(sockets.map(s => s.data.user?.userId).filter(Boolean))] } })
      .select("_id role +sessionVersion").lean(), 2000);
    const ids = [...new Set(sockets.map(s => s.data.businessId).filter(Boolean))];
    const businesses = ids.length ? await withDeadline(Business.find({ _id: { $in: ids } }).select("_id owner isActive").lean(), 2000) : [];
    const byUser = new Map(users.map(u => [String(u._id), u]));
    const byBusiness = new Map(businesses.map(b => [String(b._id), b]));
    for (const socket of sockets) {
      const user = byUser.get(socket.data.user?.userId);
      const business = byBusiness.get(socket.data.businessId);
      if (!user || user.role !== socket.data.user.role || Number(user.sessionVersion || 0) !== socket.data.sessionVersion ||
        socket.data.tokenExpiresAt <= Date.now() ||
        (socket.data.businessId && (!business || !business.isActive || String(business.owner) !== String(user._id)))) socket.disconnect(true);
    }
  } catch {
    // Do not continue broadcasting private data when revalidation is unavailable.
    for (const socket of sockets) socket.disconnect(true);
  }
};

export const startSocketSessionMaintenance = (io) => {
  let running = false;
  const interval = Math.max(1000, Math.min(60000, Number(process.env.SOCKET_REVALIDATE_MS) || 15000));
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await revalidateSocketSessions(io); } finally { running = false; }
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
};

export const enforceSocketExpiry = (socket) => {
  let timer;
  const check = () => {
    const remaining = socket.data.tokenExpiresAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return socket.disconnect(true);
    timer = setTimeout(check, Math.min(remaining, 2147483647));
    timer.unref?.();
  };
  check();
  socket.once("disconnect", () => clearTimeout(timer));
};
