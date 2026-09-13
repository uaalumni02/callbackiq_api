
import mongoose from "mongoose";

import Business from "../../src/models/business.js";
import CallLog from "../../src/models/callLog.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();

  await Promise.all([
    CallLog.init(),
    Message.init(),
  ]);
}, 60_000);

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const createBusinessAndConversation = async ({
  businessName,
  phone,
  customerPhone,
}) => {
  const business = await Business.create({
    owner: new mongoose.Types.ObjectId(),
    businessName,
    businessType: "plumbing",
    phone,
    isActive: true,
  });

  const conversation = await Conversation.create({
    business: business._id,
    customerPhone,
    customerName: "Test Customer",
    status: "open",
  });

  return {
    business,
    conversation,
  };
};

const buildMessage = ({
  business,
  conversation,
  providerMessageId,
  body,
}) => ({
  business: business._id,
  conversation: conversation._id,
  direction: "inbound",
  from: conversation.customerPhone,
  to: business.phone,
  body,
  provider: "twilio",
  providerMessageId,
  status: "received",
});

const buildCall = ({
  business,
  providerCallId,
  from,
}) => ({
  business: business._id,
  from,
  to: business.phone,
  direction: "inbound",
  status: "missed",
  provider: "twilio",
  providerCallId,
});

describe("Phase 0 provider unique indexes", () => {
  test("rejects a duplicate providerMessageId for the same business", async () => {
    const fixture = await createBusinessAndConversation({
      businessName: "First Plumbing",
      phone: "4045551000",
      customerPhone: "4045551001",
    });

    await Message.create(
      buildMessage({
        ...fixture,
        providerMessageId: "SM_UNIQUE_123",
        body: "First",
      }),
    );

    await expect(
      Message.create(
        buildMessage({
          ...fixture,
          providerMessageId: "SM_UNIQUE_123",
          body: "Duplicate",
        }),
      ),
    ).rejects.toMatchObject({
      code: 11000,
    });
  });

  test("allows the same providerMessageId for different businesses", async () => {
    const first = await createBusinessAndConversation({
      businessName: "First Plumbing",
      phone: "4045551000",
      customerPhone: "4045551001",
    });

    const second = await createBusinessAndConversation({
      businessName: "Second Plumbing",
      phone: "4045552000",
      customerPhone: "4045552001",
    });

    await Message.create(
      buildMessage({
        ...first,
        providerMessageId: "SM_SHARED_123",
        body: "First business",
      }),
    );

    await Message.create(
      buildMessage({
        ...second,
        providerMessageId: "SM_SHARED_123",
        body: "Second business",
      }),
    );

    expect(
      await Message.countDocuments({
        providerMessageId: "SM_SHARED_123",
      }),
    ).toBe(2);
  });

  test("allows multiple manual messages with an empty provider ID", async () => {
    const fixture = await createBusinessAndConversation({
      businessName: "Manual Plumbing",
      phone: "4045553000",
      customerPhone: "4045553001",
    });

    await Message.create(
      buildMessage({
        ...fixture,
        providerMessageId: "",
        body: "Manual one",
      }),
    );

    await Message.create(
      buildMessage({
        ...fixture,
        providerMessageId: "",
        body: "Manual two",
      }),
    );

    expect(
      await Message.countDocuments({
        business: fixture.business._id,
      }),
    ).toBe(2);
  });

  test("rejects a duplicate providerCallId for the same business", async () => {
    const fixture = await createBusinessAndConversation({
      businessName: "Call Plumbing",
      phone: "4045554000",
      customerPhone: "4045554001",
    });

    await CallLog.create(
      buildCall({
        business: fixture.business,
        providerCallId: "CA_UNIQUE_123",
        from: "4045554001",
      }),
    );

    await expect(
      CallLog.create(
        buildCall({
          business: fixture.business,
          providerCallId: "CA_UNIQUE_123",
          from: "4045554002",
        }),
      ),
    ).rejects.toMatchObject({
      code: 11000,
    });
  });

  test("allows the same providerCallId for different businesses", async () => {
    const first = await createBusinessAndConversation({
      businessName: "First Call Plumbing",
      phone: "4045555000",
      customerPhone: "4045555001",
    });

    const second = await createBusinessAndConversation({
      businessName: "Second Call Plumbing",
      phone: "4045556000",
      customerPhone: "4045556001",
    });

    await CallLog.create(
      buildCall({
        business: first.business,
        providerCallId: "CA_SHARED_123",
        from: "4045555001",
      }),
    );

    await CallLog.create(
      buildCall({
        business: second.business,
        providerCallId: "CA_SHARED_123",
        from: "4045556001",
      }),
    );

    expect(
      await CallLog.countDocuments({
        providerCallId: "CA_SHARED_123",
      }),
    ).toBe(2);
  });

  test("allows multiple non-provider call logs with an empty provider ID", async () => {
    const fixture = await createBusinessAndConversation({
      businessName: "Manual Call Plumbing",
      phone: "4045557000",
      customerPhone: "4045557001",
    });

    await CallLog.create(
      buildCall({
        business: fixture.business,
        providerCallId: "",
        from: "4045557001",
      }),
    );

    await CallLog.create(
      buildCall({
        business: fixture.business,
        providerCallId: "",
        from: "4045557002",
      }),
    );

    expect(
      await CallLog.countDocuments({
        business: fixture.business._id,
      }),
    ).toBe(2);
  });
});
