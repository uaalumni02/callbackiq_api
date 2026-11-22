jest.mock("../../src/db/db.js", () => ({
  __esModule: true,
  default: {
    getBusinessByOwner: jest.fn(),
    updateBusinessByOwner: jest.fn(),
    getBusinessScopeByOwner: jest.fn(),
    saveBusiness: jest.fn(),
    adminUpdateBusinessStatus: jest.fn(),
    createAdminActionLog: jest.fn(),
  },
}));
jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: { exists: jest.fn() },
}));
jest.mock("../../src/models/user.js", () => ({
  __esModule: true,
  default: { findByIdAndUpdate: jest.fn() },
}));
jest.mock("../../src/services/businessReadiness.service.js", () => ({
  assertBookingCanBeEnabled: jest.fn(),
}));

import BusinessController from "../../src/controllers/business.js";
import AdminController from "../../src/controllers/admin.js";
import Db from "../../src/db/db.js";
import Business from "../../src/models/business.js";
import User from "../../src/models/user.js";
import { FORWARDING_PHONE_CONFLICT } from "../../src/helpers/forwardingPhonePolicy.js";

const ownerId = "507f1f77bcf86cd799439011";
const currentBusiness = {
  _id: "507f1f77bcf86cd799439012",
  owner: ownerId,
  businessName: "Original Business",
  businessType: "other",
  forwardingPhone: "",
};
const request = () => ({
  user: { userId: ownerId },
  body: {
    businessName: "Previously Unused Setup Name",
    forwardingPhone: "(404) 555-1234",
  },
});
const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

beforeEach(() => {
  jest.resetAllMocks();
  Db.getBusinessByOwner.mockResolvedValue(currentBusiness);
});

test("setup identifies the phone conflict even when the business name is new", async () => {
  Business.exists.mockResolvedValue({ _id: "507f1f77bcf86cd799439013" });
  const res = response();

  await BusinessController.updateMyBusiness(request(), res);

  expect(Business.exists).toHaveBeenCalledWith({
    _id: { $ne: currentBusiness._id },
    isActive: { $ne: false },
    forwardingPhone: { $in: expect.arrayContaining(["+14045551234", "4045551234"]) },
  });
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(FORWARDING_PHONE_CONFLICT);
  expect(Db.updateBusinessByOwner).not.toHaveBeenCalled();
  expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
});

test.each(["", "+14045551234"])(
  "setup saves a new name when no other business owns the phone (current phone: %s)",
  async (forwardingPhone) => {
    Db.getBusinessByOwner.mockResolvedValue({ ...currentBusiness, forwardingPhone });
    Business.exists.mockResolvedValue(null);
    const updatedBusiness = {
      ...currentBusiness,
      businessName: "Previously Unused Setup Name",
      forwardingPhone: "+14045551234",
    };
    Db.updateBusinessByOwner.mockResolvedValue(updatedBusiness);
    const res = response();

    await BusinessController.updateMyBusiness(request(), res);

    expect(Db.updateBusinessByOwner).toHaveBeenCalledWith(
      Business,
      ownerId,
      expect.objectContaining({
        businessName: updatedBusiness.businessName,
        forwardingPhone: "+14045551234",
      }),
    );
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      ownerId,
      { $set: { businessName: updatedBusiness.businessName, businessPhone: "+14045551234" } },
      { runValidators: true },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: updatedBusiness }));
  },
);


test("a concurrent claim rejected by the unique index has the same safe response", async () => {
  Business.exists.mockResolvedValue(null);
  Db.updateBusinessByOwner.mockRejectedValue(Object.assign(new Error("duplicate key"), {
    code: 11000, keyPattern: { forwardingPhone: 1 }, keyValue: { forwardingPhone: "+14045551234" },
  }));
  const res = response();
  await BusinessController.updateMyBusiness(request(), res);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(FORWARDING_PHONE_CONFLICT);
  expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
});


test("an owned business offers resume setup without creating or transferring a record", async () => {
  Db.getBusinessScopeByOwner.mockResolvedValue(currentBusiness);
  const res = response();
  await BusinessController.createBusiness(request(), res);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    code: "BUSINESS_ALREADY_EXISTS", recovery: { action: "resume_setup", path: "/setup" },
  }));
  expect(Db.saveBusiness).not.toHaveBeenCalled();
  expect(Business.exists).not.toHaveBeenCalled();
});

test("creating a business cannot claim a phone held by another account", async () => {
  Db.getBusinessScopeByOwner.mockResolvedValue(null);
  Business.exists.mockResolvedValue({ _id: "another-business" });
  const res = response();
  await BusinessController.createBusiness(request(), res);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(FORWARDING_PHONE_CONFLICT);
  expect(Db.saveBusiness).not.toHaveBeenCalled();
});

test("admin reactivation reports a phone collision without claiming the change succeeded", async () => {
  Db.adminUpdateBusinessStatus.mockRejectedValue(Object.assign(new Error("duplicate key"), {
    code: 11000, keyPattern: { forwardingPhone: 1 },
  }));
  const res = response();
  await AdminController.updateBusinessStatus({
    user: { userId: ownerId, role: "admin" }, params: { businessId: currentBusiness._id }, body: { isActive: true },
  }, res);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(FORWARDING_PHONE_CONFLICT);
  expect(Db.createAdminActionLog).not.toHaveBeenCalled();
});
