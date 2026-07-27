import Business from "../../src/models/business.js";
import getOwnedBusiness, { getOwnedBusiness as named } from "../../src/services/businessScope.service.js";

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

describe("getOwnedBusiness", () => {
  beforeEach(() => Business.findOne.mockReset());

  test("exports the named implementation as default", () => {
    expect(getOwnedBusiness).toBe(named);
  });

  test.each([
    [{ userId: "u1" }, { owner: "u1" }],
    [{ _id: "u2" }, { owner: "u2" }],
    [{ id: "u3" }, { owner: "u3" }],
  ])("scopes an owner using supported user IDs", async (user, expectedQuery) => {
    const business = { _id: "b1" };
    Business.findOne.mockResolvedValue(business);
    await expect(getOwnedBusiness({ user })).resolves.toBe(business);
    expect(Business.findOne).toHaveBeenCalledWith(expectedQuery);
  });

  test.each(["admin", "administrator", "superadmin", "super_admin"])(
    "allows %s to request a business",
    async (role) => {
      Business.findOne.mockResolvedValue({ _id: "requested" });
      await getOwnedBusiness({ user: { userId: "u1", role }, requestedBusinessId: "requested" });
      expect(Business.findOne).toHaveBeenCalledWith({ _id: "requested" });
    },
  );

  test("does not let a non-admin escape owner scope", async () => {
    Business.findOne.mockResolvedValue({ _id: "owned" });
    await getOwnedBusiness({
      user: { userId: "u1", role: "owner" },
      requestedBusinessId: "other",
    });
    expect(Business.findOne).toHaveBeenCalledWith({ owner: "u1" });
  });

  test("returns a 404 error when no business is found", async () => {
    Business.findOne.mockResolvedValue(null);
    await expect(getOwnedBusiness({ user: { userId: "u1" } })).rejects.toMatchObject({
      message: "Business not found.",
      statusCode: 404,
    });
  });
});
