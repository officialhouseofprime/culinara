// Sends CULINARA's transactional emails (verification, welcome, password
// reset, application decisions).
//
// Three modes, checked in this order:
//   1. BREVO_API_KEY set   -> sends over HTTPS via Brevo's REST API. This is
//      the recommended option for free-tier hosts (Render, Railway, etc)
//      that block outbound SMTP ports (25/465/587) but never block HTTPS.
//   2. SMTP_HOST set       -> sends via traditional SMTP (nodemailer). Works
//      fine locally and on hosts/plans that don't block SMTP ports.
//   3. Neither set         -> dev mode: prints the email to the console
//      instead of sending it, so you can build/test the whole flow locally.

const nodemailer = require('nodemailer');

let transporter = null;
let warnedNoEmailProvider = false;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

async function sendViaBrevo({ to, subject, html }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      // Brevo's API wants a bare email address here (unlike SMTP's combined
      // "Name <email>" header format) — so this always uses BREVO_SENDER_EMAIL
      // specifically, never FROM_EMAIL, even if FROM_EMAIL is also set.
      sender: { email: process.env.BREVO_SENDER_EMAIL, name: 'CULINARA' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo API error (${res.status}): ${body}`);
  }
  return res.json();
}

async function sendEmail({ to, subject, html }) {
  if (process.env.BREVO_API_KEY) {
    return sendViaBrevo({ to, subject, html });
  }

  const t = getTransporter();

  if (!t) {
    if (!warnedNoEmailProvider) {
      console.log('\n[mailer] No BREVO_API_KEY or SMTP_HOST set in .env — running in dev mode.');
      console.log('[mailer] Emails will be printed here instead of sent.\n');
      warnedNoEmailProvider = true;
    }
    console.log(`\n----- DEV EMAIL -----\nTo: ${to}\nSubject: ${subject}\n\n${htmlToText(html)}\n----------------------\n`);
    return { simulated: true };
  }

  return t.sendMail({
    from: process.env.FROM_EMAIL || 'CULINARA <culinarateam@gmail.com>',
    to,
    subject,
    html,
  });
}

function htmlToText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}


function layout(bodyHtml) {
  return `
  <div style="font-family: Georgia, serif; background:#1B1712; padding:40px 20px;">
    <div style="max-width:480px;margin:0 auto;background:#F1E7D4;color:#2B2117;border-radius:4px;padding:36px 32px;">
      <p style="font-family: Georgia, serif; font-size:20px; letter-spacing:0.04em; color:#B5502E; margin:0 0 24px;">CULINARA</p>
      ${bodyHtml}
      <p style="margin-top:32px;font-size:12px;color:#6B5E4B;">CULINARA · you're receiving this because you signed up at culinara.com</p>
    </div>
  </div>`;
}

const templates = {
  verifyEmail(name, link) {
    return layout(`
      <h2 style="margin:0 0 16px;font-size:20px;">Confirm your email, ${escapeHtml(name)}</h2>
      <p style="font-size:14.5px;line-height:1.6;">Click the button below to verify your email and activate your CULINARA account.</p>
      <p style="margin:28px 0;"><a href="${link}" style="background:#C99A3D;color:#201804;padding:12px 22px;border-radius:4px;text-decoration:none;font-weight:bold;">Verify email</a></p>
      <p style="font-size:12.5px;color:#6B5E4B;">If the button doesn't work, paste this link into your browser:<br>${link}</p>
    `);
  },
  chefApplicationReceived(name) {
    return layout(`
      <h2 style="margin:0 0 16px;font-size:20px;">Thanks for applying, ${escapeHtml(name)}</h2>
      <p style="font-size:14.5px;line-height:1.6;">We've received your chef application, along with your CV and cover letter. Our team reviews every application by hand — we'll email you as soon as a decision is made.</p>
    `);
  },
  chefInterviewInvite(name) {
    return layout(`
      <h2 style="margin:0 0 16px;font-size:20px;">You're verified, ${escapeHtml(name)} — one more step</h2>
      <p style="font-size:14.5px;line-height:1.6;">Thanks for confirming your email. Next, our team will reach out within the next <strong>2 business days</strong> to schedule a short online interview — just a quick conversation about your cooking and the kind of work you want to do.</p>
      <p style="font-size:14.5px;line-height:1.6;">In the meantime, you can already log in to build out your profile: add your chef type, your preferred rate, and start posting photos or video of your work to your portfolio.</p>
    `);
  },
  chefApproved(name, loginLink) {
    return layout(`
      <h2 style="margin:0 0 16px;font-size:20px;">You're on the pass, ${escapeHtml(name)} 🔪</h2>
      <p style="font-size:14.5px;line-height:1.6;">Your CULINARA chef profile has been approved. You can now log in, complete your profile, and start posting photos and videos of your work.</p>
      <p style="margin:28px 0;"><a href="${loginLink}" style="background:#C99A3D;color:#201804;padding:12px 22px;border-radius:4px;text-decoration:none;font-weight:bold;">Log in to your profile</a></p>
      <p style="font-size:12.5px;color:#6B5E4B;">If the button doesn't work, paste this link into your browser:<br>${loginLink}</p>
    `);
  },
  chefRejected(name) {
    return layout(`
      <h2 style="margin:0 0 16px;font-size:20px;">About your CULINARA application</h2>
      <p style="font-size:14.5px;line-height:1.6;">Hi ${escapeHtml(name)}, thank you for applying to CULINARA. After review, we're not able to approve your profile at this time. We'd love for you to apply again in the future as your portfolio grows.</p>
    `);
  },
  clientWelcome(name, siteLink) {
    return layout(`
      <h2 style="margin:0 0 16px;font-size:20px;">Welcome to CULINARA, ${escapeHtml(name)}</h2>
      <p style="font-size:14.5px;line-height:1.6;">Your account is ready. Browse chefs on the pass and reach out directly to start planning your next meal.</p>
      <p style="margin:28px 0;"><a href="${siteLink}" style="background:#C99A3D;color:#201804;padding:12px 22px;border-radius:4px;text-decoration:none;font-weight:bold;">Browse chefs</a></p>
      <p style="font-size:12.5px;color:#6B5E4B;">If the button doesn't work, paste this link into your browser:<br>${siteLink}</p>
    `);
  },
  passwordReset(name, link) {
    return layout(`
      <h2 style="margin:0 0 16px;font-size:20px;">Reset your password</h2>
      <p style="font-size:14.5px;line-height:1.6;">Hi ${escapeHtml(name)}, click below to set a new password. This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
      <p style="margin:28px 0;"><a href="${link}" style="background:#C99A3D;color:#201804;padding:12px 22px;border-radius:4px;text-decoration:none;font-weight:bold;">Reset password</a></p>
      <p style="font-size:12.5px;color:#6B5E4B;">If the button doesn't work, paste this link into your browser:<br>${link}</p>
    `);
  },
};

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { sendEmail, templates };
