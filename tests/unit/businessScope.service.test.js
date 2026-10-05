import mongoose from "mongoose";
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
      Business.findOne.mockResolvedValue({ _id: "66c000000000000000000001" });
      await getOwnedBusiness({ user: { userId: "u1", role }, requestedBusinessId: "66c000000000000000000001" });
      expect(Business.findOne).toHaveBeenCalledWith({ _id: "66c000000000000000000001" });
    },
  );

  test("requires both the explicit business ID and owner to match", async () => {
    Business.findOne.mockResolvedValue(null);
    const requestedBusinessId = "66c000000000000000000002";
    await expect(getOwnedBusiness({
      user: { userId: "u1", role: "owner" }, requestedBusinessId,
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(Business.findOne).toHaveBeenCalledWith({ owner: "u1", _id: requestedBusinessId });
  });

  test.each(["owner", "staff", "ADMIN", "administrator", "superadmin", "super_admin"])(
    "%s can resolve its own explicit business ID", async (role) => {
      const business = { _id: new mongoose.Types.ObjectId() };
      Business.findOne.mockResolvedValue(business);
      await expect(getOwnedBusiness({ user: { userId: "u1", role }, requestedBusinessId: business._id }))
        .resolves.toBe(business);
    },
  );

  test.each([null, undefined, ""])("preserves implicit owner lookup for %p", async (requestedBusinessId) => {
    Business.findOne.mockResolvedValue({ _id: "b1" });
    await getOwnedBusiness({ user: { userId: "u1", role: "admin" }, requestedBusinessId });
    expect(Business.findOne).toHaveBeenCalledWith({ owner: "u1" });
  });

  test.each(["bad-id", " ", 123, false, [], ["66c000000000000000000001"], { $ne: null }, { id: "66c000000000000000000001" }])(
    "rejects malformed or operator-shaped business IDs: %p", async (requestedBusinessId) => {
      for (const role of ["owner", "admin"]) {
        await expect(getOwnedBusiness({ user: { userId: "u1", role }, requestedBusinessId }))
          .rejects.toMatchObject({ statusCode: 400 });
      }
      expect(Business.findOne).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, {}, { role: "admin" }])("requires an authenticated identity: %p", async (user) => {
    await expect(getOwnedBusiness({ user, requestedBusinessId: "66c000000000000000000001" }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(Business.findOne).not.toHaveBeenCalled();
  });

  test("returns a 404 error when no business is found", async () => {
    Business.findOne.mockResolvedValue(null);
    await expect(getOwnedBusiness({ user: { userId: "u1" } })).rejects.toMatchObject({
      message: "Business not found.",
      statusCode: 404,
    });
  });
});
