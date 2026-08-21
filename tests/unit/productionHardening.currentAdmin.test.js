const mockFindById = jest.fn();

jest.mock("../../src/models/user.js", () => ({
  __esModule: true,
  default: {
    findById: mockFindById,
  },
}));

import {
  getCurrentAuthorizationUser,
  isCurrentAdminRequest,
} from "../../src/helpers/security/current-admin.js";

const setLookupResult = (value) => {
  mockFindById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  });
};

describe("fresh admin authorization", () => {
  beforeEach(() => {
    mockFindById.mockReset();
  });

  test("returns null without a current user id", async () => {
    await expect(getCurrentAuthorizationUser({ user: null })).resolves.toBeNull();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  test("accepts current admin role from MongoDB", async () => {
    setLookupResult({ _id: "u1", role: "admin" });
    await expect(
      isCurrentAdminRequest({ user: { userId: "u1", role: "owner" } }),
    ).resolves.toBe(true);
  });

  test("rejects stale JWT admin role after database demotion", async () => {
    setLookupResult({ _id: "u1", role: "owner" });
    await expect(
      isCurrentAdminRequest({ user: { userId: "u1", role: "admin" } }),
    ).resolves.toBe(false);
  });

  test("rejects missing current user", async () => {
    setLookupResult(null);
    await expect(
      isCurrentAdminRequest({ user: { userId: "u1", role: "admin" } }),
    ).resolves.toBe(false);
  });
});
