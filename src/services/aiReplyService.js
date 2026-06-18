import OpenAI from "openai";

let openai = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

const fallbackReply =
  "Thanks for reaching out. A team member will follow up with you shortly.";

export const generateAIReply = async ({ business, lead, messages = [] }) => {
  if (!openai) {
    return fallbackReply;
  }

  const history = messages
    .slice(-10)
    .map((msg) => {
      const text = msg.body || msg.content || msg.message || "";
      return `${msg.direction}: ${text}`;
    })
    .join("\n");

  const prompt = `
You are an AI receptionist for ${business?.businessName || "this business"}.

Your job:
- Reply professionally by SMS
- Help qualify the customer
- Ask one question at a time
- Try to move the customer toward booking
- Do not promise exact pricing
- If the customer wants a human, say someone will follow up
- Keep the reply under 320 characters

Business:
Name: ${business?.businessName || "Unknown"}
Type: ${business?.businessType || "Service business"}
Phone: ${business?.phone || "Unknown"}

Lead:
Customer: ${lead?.customerName || "Unknown"}
Phone: ${lead?.phone || "Unknown"}
Service Needed: ${lead?.serviceNeeded || "Unknown"}

Conversation:
${history || "No previous messages."}

Write the next SMS reply.
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    });

    return response.choices?.[0]?.message?.content?.trim() || fallbackReply;
  } catch (error) {
    console.error("AI reply generation error:", error);
    return fallbackReply;
  }
};
