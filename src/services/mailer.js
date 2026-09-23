// Outgoing e-mail, for alerts the operator must hear about without having the
// UI open (see signalMonitor.js).
//
// Gmail by default: SMTP over implicit TLS at smtp.gmail.com:465 with a Google
// APP PASSWORD, not the account password — Google refuses plain passwords over
// SMTP, and an app password needs 2-Step Verification on the account
// (myaccount.google.com → Security → App passwords). Google shows it as four
// groups of four letters; the spaces are cosmetic and stripped here.
//
// config.json:
//   "email": {
//     "user": "glc.monitor@gmail.com",
//     "appPassword": "abcd efgh ijkl mnop",
//     "fromName": "GLC Signal Monitor",
//     "recipients": ["ops@example.gy", "engineer@example.gy"],
//     "host": "smtp.gmail.com", "port": 465          // optional, other providers
//   }

import { loadConfig } from '../config.js';

// nodemailer is loaded on first use, not at import: e-mail is an optional
// feature, and a folder updated with `git pull` but not `npm install` must
// still start the scheduler — it used to die at boot on ERR_MODULE_NOT_FOUND.
let nodemailerModule = null;
let nodemailerMissing = false;
async function loadNodemailer() {
  if (nodemailerModule) return nodemailerModule;
  try {
    nodemailerModule = (await import('nodemailer')).default;
    nodemailerMissing = false;
    return nodemailerModule;
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    nodemailerMissing = true;
    throw new Error('the nodemailer package is not installed — run "npm install" in the app folder, then restart');
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());

export function emailConfig() {
  const e = loadConfig().email || {};
  return {
    host: e.host || 'smtp.gmail.com',
    port: Number(e.port) || 465,
    user: String(e.user || '').trim(),
    appPassword: String(e.appPassword || '').replace(/\s+/g, ''),
    fromName: e.fromName || 'OTAV Signal Monitor',
    recipients: (Array.isArray(e.recipients) ? e.recipients : [])
      .map((r) => String(r).trim()).filter(isEmail),
  };
}

/** Why mail cannot be sent right now, or null when it can. */
export function emailProblem(c = emailConfig()) {
  if (nodemailerMissing && !transportOverride) return 'nodemailer not installed (run npm install)';
  if (!c.user) return 'no sender account configured';
  if (!c.appPassword) return 'no app password configured';
  if (!c.recipients.length) return 'no recipients configured';
  return null;
}

// Tests swap in a nodemailer jsonTransport so nothing leaves the machine.
let transportOverride = null;
export function setTransportForTests(t) { transportOverride = t; }

async function transportFor(c) {
  if (transportOverride) return transportOverride;
  const nodemailer = await loadNodemailer();
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465,        // 465 = implicit TLS; 587 upgrades with STARTTLS
    auth: { user: c.user, pass: c.appPassword },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

/**
 * Send one message to every configured recipient (BCC'd, so an alert doesn't
 * hand the whole list to anyone who replies-all). Throws with a readable reason.
 */
export async function sendMail({ subject, text, html, to = null }) {
  const c = emailConfig();
  const recipients = to || c.recipients;
  const problem = emailProblem({ ...c, recipients });
  if (problem) throw new Error(`e-mail not sent: ${problem}`);
  const transport = await transportFor(c);
  try {
    return await transport.sendMail({
      from: { name: c.fromName, address: c.user },
      to: { name: c.fromName, address: c.user },
      bcc: recipients,
      subject,
      text,
      html,
    });
  } catch (err) {
    // The two answers Gmail actually gives, turned into something actionable.
    if (err.code === 'EAUTH' || err.responseCode === 535) {
      throw new Error('Gmail refused the login — use an App Password (Google account → Security → '
        + '2-Step Verification → App passwords), not the account password');
    }
    throw new Error(`e-mail not sent: ${err.message}`);
  }
}
