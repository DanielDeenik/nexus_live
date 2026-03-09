/**
 * lib/magicLink.js — Generate + send magic-link emails
 *
 * Token: 32-byte crypto random, stored hashed in DB with 1-hour expiry.
 * Email: Sent via nodemailer (SMTP_* env vars) or logged to console if not configured.
 */

const crypto    = require('crypto');
const nodemailer = require('nodemailer');

// ─── Token generation ────────────────────────────────────────────────────────

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── Mailer ───────────────────────────────────────────────────────────────────

function createTransport() {
  if (!process.env.SMTP_HOST) {
    // Return a test transport that logs to console
    return {
      sendMail(opts) {
        console.log('\n📧 [magic-link] SMTP not configured — email content:\n');
        console.log('  To:', opts.to);
        console.log('  Subject:', opts.subject);
        console.log('  Link:', opts.text?.match(/https?:\/\/\S+/)?.[0] || '(see html)');
        console.log();
        return Promise.resolve({ messageId: 'console-' + Date.now() });
      }
    };
  }

  return nodemailer.createTransporter({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

const transport = createTransport();

// ─── Send magic link ──────────────────────────────────────────────────────────

async function sendMagicLink(email, token, baseUrl) {
  const link = `${baseUrl}/auth/magic?token=${token}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#0f172a">Sign in to Nexus</h2>
      <p style="color:#475569">Click the button below to sign in. This link expires in 1 hour.</p>
      <a href="${link}"
         style="display:inline-block;background:#4fffb0;color:#0f172a;font-weight:600;
                padding:12px 24px;border-radius:8px;text-decoration:none;margin:16px 0">
        Sign in →
      </a>
      <p style="color:#94a3b8;font-size:12px">
        Or paste this URL in your browser:<br>
        <a href="${link}" style="color:#64748b">${link}</a>
      </p>
      <p style="color:#cbd5e1;font-size:11px">If you didn't request this, ignore this email.</p>
    </body>
    </html>
  `;

  await transport.sendMail({
    from:    process.env.SMTP_FROM || 'Nexus <noreply@nexus.app>',
    to:      email,
    subject: 'Your Nexus sign-in link',
    text:    `Sign in to Nexus: ${link}\n\nThis link expires in 1 hour.`,
    html,
  });

  return link;
}

module.exports = { generateToken, sendMagicLink };
