import mongoose from 'mongoose';
export const queryBudgetMs = () => Math.max(100, Math.min(5000, Number(process.env.OWNER_QUERY_MAX_TIME_MS) || 3000));
export const invalidPage = message => Object.assign(new Error(message), { code: 'INVALID_CURSOR', statusCode: 400 });
export const encodePage = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function decodePage(value, scope) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 2048) throw invalidPage('Invalid pagination cursor');
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (cursor.scope !== scope || !mongoose.isValidObjectId(cursor.id) || !Number.isFinite(Date.parse(cursor.at))) throw new Error();
    return { at: new Date(cursor.at), id: new mongoose.Types.ObjectId(cursor.id) };
  } catch { throw invalidPage('Invalid pagination cursor for this request'); }
}
export const pageLimit = value => Math.max(1, Math.min(100, Math.floor(Number(value) || 50)));
export const beforePage = (cursor, field) => cursor ? { $or: [{ [field]: { $lt: cursor.at } }, { [field]: cursor.at, _id: { $lt: cursor.id } }] } : {};
export function finishPage(rows, limit, scope, field = 'createdAt') {
  const hasMore = rows.length > limit, items = rows.slice(0, limit), last = items.at(-1);
  return { items, pagination: { limit, hasMore, nextCursor: hasMore ? encodePage({ scope, at: last[field], id: String(last._id) }) : null } };
}
export const queryFailure = error => error?.code === 50 || error?.codeName === 'MaxTimeMSExpired';
