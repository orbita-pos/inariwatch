import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock nodemailer
const mockSendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: mockSendMail,
    }),
  },
}));

// Import after mock
const { sendEmail, sendVerificationEmail } = await import("../email");

beforeEach(() => {
  mockSendMail.mockReset();
});

describe("sendEmail", () => {
  it("sends email successfully", async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: "abc-123" });

    const result = await sendEmail({ email: "user@test.com" }, "Test Subject", "<p>Hello</p>");

    expect(result).toEqual({ ok: true });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@test.com",
        subject: "Test Subject",
        html: "<p>Hello</p>",
      })
    );
  });

  it("includes a from address", async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: "abc-123" });

    await sendEmail({ email: "user@test.com" }, "Subject", "<p>Hi</p>");

    expect(mockSendMail.mock.calls[0][0].from).toBeDefined();
  });

  it("returns error on SMTP failure", async () => {
    mockSendMail.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await sendEmail({ email: "user@test.com" }, "Subject", "<p>Hi</p>");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Connection refused");
  });

  it("handles non-Error throws", async () => {
    mockSendMail.mockRejectedValueOnce("SMTP timeout");

    const result = await sendEmail({ email: "user@test.com" }, "Subject", "<p>Hi</p>");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("SMTP timeout");
  });
});

describe("sendVerificationEmail", () => {
  it("sends verification email with code", async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: "abc-123" });

    const result = await sendVerificationEmail("user@test.com", "123456");

    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@test.com",
        subject: "InariWatch — Verify your email",
        html: expect.stringContaining("123456"),
      })
    );
  });

  it("includes verification code in HTML body", async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: "abc-123" });

    await sendVerificationEmail("user@test.com", "654321");

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain("654321");
    expect(html).toContain("Verify your email");
  });

  it("propagates SMTP errors", async () => {
    mockSendMail.mockRejectedValueOnce(new Error("Authentication failed"));

    const result = await sendVerificationEmail("user@test.com", "123456");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Authentication failed");
  });
});
