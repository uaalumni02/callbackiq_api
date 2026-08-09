import nodemailer from "nodemailer";
import DemoNotificationService, {
  getConfig,
} from "../../src/services/demoNotification.service.js";

jest.mock("nodemailer", () => ({
  __esModule: true,
  default: {
    createTransport: jest.fn(),
  },
}));

const ORIGINAL_ENV = { ...process.env };

const demo = {
  _id: "66b7d90d6e4c210001000001",
  fullName: "John Smith",
  email: "john@example.com",
  phone: "4045551212",
  businessName: "Atlanta Pro Plumbing",
  businessType: "Plumbing",
  monthlyCallVolume: "250–500",
  message: "We miss after-hours calls.",
  scheduledAt: new Date("2026-08-10T14:30:00.000Z"),
  timezone: "America/New_York",
  meetingUrl: "https://meet.example.com/demo",
};

describe("DemoNotificationService Gmail configuration", () => {
  let sendMail;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      EMAIL_SENDER_NAME: "callbackiq",
      GMAIL_ADDRESS: "admin@example.com",
      GMAIL_PASSWORD: "app-password-value",
      PUBLIC_APP_URL: "https://callbackiq.example",
    };
    delete process.env.RESEND_API_KEY;
    delete process.env.DEMO_FROM_EMAIL;
    delete process.env.DEMO_NOTIFICATION_EMAIL;

    sendMail = jest.fn().mockResolvedValue({ messageId: "test-message" });
    nodemailer.createTransport.mockReset();
    nodemailer.createTransport.mockReturnValue({ sendMail });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test("uses the existing Gmail environment and defaults admin alerts to GMAIL_ADDRESS", () => {
    expect(getConfig()).toMatchObject({
      gmailAddress: "admin@example.com",
      gmailPassword: "app-password-value",
      senderName: "callbackiq",
      adminEmail: "admin@example.com",
    });
    expect(DemoNotificationService.isConfigured()).toBe(true);
  });

  test("sends through Nodemailer Gmail using EMAIL_SENDER_NAME", async () => {
    await expect(
      DemoNotificationService.send({
        to: "prospect@example.com",
        subject: "Test demo email",
        html: "<p>Hello</p>",
      }),
    ).resolves.toBe(true);

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      service: "gmail",
      auth: {
        user: "admin@example.com",
        pass: "app-password-value",
      },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: "callbackiq <admin@example.com>",
      to: "prospect@example.com",
      subject: "Test demo email",
      html: "<p>Hello</p>",
    });
  });

  test("notifies both prospect and the Gmail admin inbox after scheduling", async () => {
    const result = await DemoNotificationService.notifyScheduled(
      demo,
      "booking-token",
    );

    expect(result).toHaveLength(2);
    expect(sendMail).toHaveBeenCalledTimes(2);

    const messages = sendMail.mock.calls.map(([message]) => message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: "john@example.com",
          subject: "Your CallBackIQ demo is booked",
        }),
        expect.objectContaining({
          to: "admin@example.com",
          subject: "Demo scheduled — Atlanta Pro Plumbing",
        }),
      ]),
    );
  });

  test("does not attempt delivery when Gmail credentials are incomplete", async () => {
    delete process.env.GMAIL_PASSWORD;

    expect(DemoNotificationService.isConfigured()).toBe(false);
    await expect(
      DemoNotificationService.send({
        to: "prospect@example.com",
        subject: "Test",
        html: "<p>Test</p>",
      }),
    ).resolves.toBe(false);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  test("allows DEMO_NOTIFICATION_EMAIL to override the admin inbox", () => {
    process.env.DEMO_NOTIFICATION_EMAIL = "sales@example.com";
    expect(getConfig().adminEmail).toBe("sales@example.com");
  });
});
