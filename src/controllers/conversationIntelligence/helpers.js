



import Db from "../../db/db.js";




import Message from "../../models/message.js";





const getMessagesForAnalysis = (conversationId,businessId) => Db.getMessagesForAI(Message,conversationId,businessId);

export { getMessagesForAnalysis };
