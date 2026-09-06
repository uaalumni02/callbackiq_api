import Db from "../../src/db/db.js";
import Token from "../../src/helpers/jwt/token.js";
import checkAuth from "../../src/middleware/check-auth.js";
import User from "../../src/models/user.js";

jest.mock("../../src/helpers/jwt/token.js", () => ({
  __esModule: true,
  default: {
    verify: jest.fn(),
  },
}));

jest.mock("../../src/models/user.js", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
  },
}));

const mockUserLookup = (user) => {
  const lean = jest.fn().mockResolvedValue(user);
  const select = jest.fn().mockReturnValue({ lean });
  User.findById.mockReturnValue({ select });
  return { select, lean };
};

const response = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe("release invariant: password reset revokes old JWTs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("legacy version-0 token remains valid for an untouched version-0 account", async () => {
    Token.verify.mockReturnValue({ userId: "u1", role: "owner" });
    mockUserLookup({ _id: "u1", role: "owner", sessionVersion: 0 });
    const req = { cookies: { token: "jwt" }, headers: {} };
    const res = response();
    const next = jest.fn();

    await checkAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.sessionVersion).toBe(0);
  });

  test("a stale token is rejected after sessionVersion increments", async () => {
    Token.verify.mockReturnValue({
      userId: "u1",
      role: "owner",
      sessionVersion: 0,
    });
    mockUserLookup({ _id: "u1", role: "owner", sessionVersion: 1 });
    const req = { cookies: { token: "stale" }, headers: {} };
    const res = response();

    await checkAuth(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("current token version is accepted and role is refreshed from storage", async () => {
    Token.verify.mockReturnValue({
      userId: "u1",
      role: "admin",
      sessionVersion: 2,
    });
    mockUserLookup({ _id: "u1", role: "owner", sessionVersion: 2 });
    const req = { cookies: { token: "current" }, headers: {} };
    const res = response();
    const next = jest.fn();

    await checkAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.role).toBe("owner");
  });

  test("Db.saveResetPassword atomically increments sessionVersion", async () => {
    const fakeModel = {
      findByIdAndUpdate: jest.fn().mockResolvedValue({ _id: "u1" }),
    };

    await Db.saveResetPassword(fakeModel, "u1", "new-hash");

    const update = fakeModel.findByIdAndUpdate.mock.calls[0][1];
    expect(update.$set.password).toBe("new-hash");
    expect(update.$inc).toEqual({ sessionVersion: 1 });
  });
});
