import OpenAI from "openai";

let openaiClient = null;

const getOpenAIClient = () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openaiClient;
};

const runFollowUpAgent = async ({
  businessName,
  businessType = "other",
  customerMessage,
  lead = {},
  recentMessages = [],
}) => {
  const openai = getOpenAIClient();

  const conversationHistory = recentMessages
    .map((message) => {
      return `${message.direction}: ${message.body}`;
    })
    .join("\n");

  const prompt = `
You are CallBackIQ, an AI missed-call recovery assistant for a local service business.

Business name: ${businessName}
Business type: ${businessType}

Current lead:
${JSON.stringify(
  {
    serviceNeeded: lead.serviceNeeded,
    urgency: lead.urgency,
    address: lead.address,
    preferredAppointmentTime: lead.preferredAppointmentTime,
    leadQualityScore: lead.leadQualityScore,
    status: lead.status,
  },
  null,
  2,
)}

Recent conversation:
${conversationHistory || "No previous messages."}

Latest customer message:
"${customerMessage}"

Your job:
1. Decide the next best SMS reply.
2. Extract/update lead fields.
3. Decide if owner should be alerted.

Return ONLY valid JSON with this shape:
{
  "reply": "string",
  "serviceNeeded": "string",
  "urgency": "low | medium | high | emergency",
  "address": "string",
  "preferredAppointmentTime": "string",
  "leadQualityScore": number,
  "estimatedValue": number,
  "summary": "string",
  "shouldAlertOwner": boolean,
  "alertTitle": "string",
  "alertMessage": "string"
}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a concise SMS assistant for missed-call recovery. Return only valid JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.3,
  });

  const content = completion.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("No AI follow-up response returned");
  }

  return JSON.parse(content);
};

export { runFollowUpAgent };
