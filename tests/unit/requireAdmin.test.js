jest.mock("../../src/models/user.js", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
  },
}));

import User from "../../src/models/user.js";
import requireAdmin from "../../src/middleware/require-admin.js";

const response = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe("requireAdmin", () => {
  beforeEach(() => jest.clearAllMocks());

  test("rechecks role in the database instead of trusting the JWT role", async () => {
    User.findById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({ role: "owner" }),
      }),
    });

    const req = { user: { userId: "u1", role: "admin" } };
    const res = response();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test("allows a current database admin", async () => {
    User.findById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({ role: "admin" }),
      }),
    });

    const req = { user: { userId: "u1", role: "owner" } };
    const res = response();
    const next = jest.fn();

    await requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.role).toBe("admin");
  });
});
