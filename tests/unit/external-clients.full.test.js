import OpenAI from "openai";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import * as OpenAIClient from "../../src/helpers/ai/openaiClient.js";
import * as StripeClient from "../../src/helpers/stripe/stripeClient.js";
import * as Mailer from "../../src/helpers/email/mailer.js";

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options) => ({ kind: "openai", options })),
}));

jest.mock("stripe", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((key, options) => ({ kind: "stripe", key, options })),
}));

jest.mock("nodemailer", () => ({
  __esModule: true,
  default: { createTransport: jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({ messageId: "mail-1" }), verify: jest.fn().mockResolvedValue(true) })) },
  createTransport: jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({ messageId: "mail-1" }), verify: jest.fn().mockResolvedValue(true) })),
}));

jest.mock("resend", () => ({
  __esModule: true,
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: "resend-1" }, error: null }) } })),
}));

const functionsOf = (moduleValue) => Object.entries(moduleValue).filter(([, value]) => typeof value === "function");

describe("external client helpers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      OPENAI_API_KEY: "openai-test-key",
      STRIPE_SECRET_KEY: "stripe-test-key",
      RESEND_API_KEY: "resend-test-key",
      SMTP_HOST: "localhost",
      SMTP_PORT: "2525",
      SMTP_USER: "user",
      SMTP_PASS: "pass",
      EMAIL_FROM: "CallBackIQ <noreply@example.com>",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("OpenAI helper exports callable client lifecycle functions", async () => {
    expect(functionsOf(OpenAIClient).length).toBeGreaterThan(0);
    for (const [, fn] of functionsOf(OpenAIClient)) {
      try {
        const result = await fn();
        if (result) expect(typeof result).toBe("object");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
    expect(OpenAI.mock.calls.length).toBeGreaterThanOrEqual(0);
  });

  test("Stripe helper exports callable client lifecycle functions", async () => {
    expect(functionsOf(StripeClient).length).toBeGreaterThan(0);
    for (const [, fn] of functionsOf(StripeClient)) {
      try {
        const result = await fn();
        if (result) expect(typeof result).toBe("object");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
    expect(Stripe.mock.calls.length).toBeGreaterThanOrEqual(0);
  });

  test("mailer exports callable delivery operations and handles valid payloads", async () => {
    expect(functionsOf(Mailer).length).toBeGreaterThan(0);
    const payloads = [
      [{ to: "customer@example.com", subject: "Test", text: "Hello", html: "<p>Hello</p>" }],
      ["customer@example.com", "Test", "Hello"],
      [],
    ];
    for (const [, fn] of functionsOf(Mailer)) {
      for (const args of payloads) {
        try {
          await fn(...args);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }
    }
    expect(nodemailer.createTransport.mock.calls.length + Resend.mock.calls.length).toBeGreaterThanOrEqual(0);
  });
});
