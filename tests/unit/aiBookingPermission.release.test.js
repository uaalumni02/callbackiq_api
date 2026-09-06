import ServiceOffering from "../../src/models/serviceOffering.js";
import {
  getAiBookableService,
  getBookableService,
} from "../../src/services/scheduling/appointmentPolicy.service.js";

jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
  },
}));

const leanResult = (value) => ({
  lean: jest.fn().mockResolvedValue(value),
});

describe("release invariant: aiCanBook is authoritative", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    [true, true, true],
    [true, false, true],
    [false, true, false],
    [false, false, false],
  ])(
    "aiCanBook=%s aiCanDiscuss=%s -> AI bookable=%s",
    async (aiCanBook, aiCanDiscuss, allowed) => {
      ServiceOffering.findOne.mockReturnValue(
        leanResult({
          _id: "service-1",
          active: true,
          aiCanBook,
          aiCanDiscuss,
        }),
      );

      const request = getAiBookableService({
        businessId: "business-1",
        serviceOfferingId: "service-1",
      });

      if (allowed) {
        await expect(request).resolves.toMatchObject({ aiCanBook: true });
      } else {
        await expect(request).rejects.toMatchObject({
          code: "SERVICE_NOT_AI_BOOKABLE",
          statusCode: 409,
        });
      }
    },
  );

  test("staff/manual scheduling may still use an active discuss-only service", async () => {
    ServiceOffering.findOne.mockReturnValue(
      leanResult({
        _id: "service-2",
        active: true,
        aiCanBook: false,
        aiCanDiscuss: true,
      }),
    );

    await expect(
      getBookableService({
        businessId: "business-1",
        serviceOfferingId: "service-2",
      }),
    ).resolves.toMatchObject({ _id: "service-2", aiCanBook: false });
  });
});
