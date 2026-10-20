import nodemailer from 'nodemailer';

const env = process.env;

// Email is only sent once SMTP_HOST is set. Until then the email is written to the log, so nothing is lost while testing.
const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT) || 587,
      secure: Number(env.SMTP_PORT) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

export async function sendMail(to, subject, text) {
  if (!transport) {
    console.log(`[email not sent: SMTP_HOST is not set] to: ${to} | subject: ${subject} | starts: "${text.split('\n')[0]}"`);
    return;
  }
  await transport.sendMail({ from: env.MAIL_FROM || 'House Hunting <no-reply@localhost>', to, subject, text });
}

// Sent once, the first time someone signs in with Google.
export function sendWelcome(to, name) {
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const text = `${greeting}

Thank you for signing in to House Hunting using your Google account!

We're excited to have you with us. Our goal is to make finding your next home easier, faster, and more convenient.

You can now explore available properties, discover homes that match your preferences, and begin your house-hunting journey.

Thank you for choosing House Hunting!

Best regards,
The House Hunting Team`;
  return sendMail(to, 'Welcome to House Hunting', text);
}
