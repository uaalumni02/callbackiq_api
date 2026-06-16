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

const qualifyLeadWithAI = async ({ messageBody, businessType = "other" }) => {
  const openai = getOpenAIClient();

  const prompt = `
You are qualifying a missed-call recovery lead for a local service business.

Business type: ${businessType}

Customer message:
"${messageBody}"

Return ONLY valid JSON with this shape:
{
  "serviceNeeded": "string",
  "urgency": "low | medium | high | emergency",
  "address": "string",
  "preferredAppointmentTime": "string",
  "leadQualityScore": number,
  "summary": "string",
  "estimatedValue": number
}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "You extract structured lead details for local service businesses. Return only valid JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.2,
  });

  const content = completion.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("No AI response returned");
  }

  return JSON.parse(content);
};

export { qualifyLeadWithAI };
