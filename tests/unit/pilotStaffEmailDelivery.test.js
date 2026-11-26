import nodemailer from "nodemailer";
import { sendStaffReviewEmail } from "../../src/helpers/email/mailer.js";
jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
const original = { ...process.env };
let sendMail;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NODE_ENV = "production";
  process.env.CLIENT_URL = "https://app.example.com";
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_USER = "sender@example.com";
  process.env.SMTP_PASSWORD = "offline-synthetic-mail-transport";
  process.env.EMAIL_FROM = "sender@example.com";
  sendMail = jest.fn().mockResolvedValue({ accepted: ["staff@example.com"] });
  nodemailer.createTransport.mockReturnValue({ sendMail });
});
afterEach(() => {
  process.env = { ...original };
});
test.each([
  [{ critical: true }, /urgent safety/, /does not dispatch emergency help/],
  [
    { stage: "expired", appointmentId: "appointment" },
    /availability recheck/,
    /appointments/,
  ],
  [{ stage: "overdue" }, /overdue/, /intervention-center/],
  [{}, /needs review/, /acknowledge/],
])(
  "H02 staff notification email uses executed urgency and record links, without customer text: %p",
  async (options, subject, body) => {
    await sendStaffReviewEmail({
      email: "staff@example.com",
      alertId: "alert",
      ...options,
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toMatch(subject);
    expect(mail.text).toMatch(body);
    expect(mail.text).toContain("Your business");
    expect(mail.to).toBe("staff@example.com");
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
  },
);
test("H02 explicit business name is used and an SMTP rejection is observable", async () => {
  sendMail.mockRejectedValue(new Error("smtp offline"));
  await expect(
    sendStaffReviewEmail({
      email: "staff@example.com",
      businessName: "Example Roofing",
      alertId: "alert",
    }),
  ).rejects.toThrow("smtp offline");
  expect(sendMail.mock.calls[0][0].text).toContain("Example Roofing");
});
test("H02 notification links cannot use a non-HTTP scheme", () => {
  process.env.CLIENT_URL = "javascript:synthetic";
  expect(() =>
    sendStaffReviewEmail({ email: "staff@example.com", alertId: "alert" }),
  ).toThrow("Invalid CLIENT_URL");
  expect(sendMail).not.toHaveBeenCalled();
});
