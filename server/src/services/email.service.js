import nodemailer from "nodemailer";
import env, { features } from "../config/env.js";

// ISSUES #1 — the transporter is built lazily, so it can never be constructed with
// undefined credentials because of module evaluation order.
let transporter = null;
let verified = false;

export function isEmailEnabled() {
  return features.email;
}

function getTransporter() {
  if (!features.email) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: env.gmailUser, pass: env.gmailAppPassword },
    });
  }
  return transporter;
}

/** Verifies SMTP credentials once, at startup, so a bad app password fails loudly. */
export async function verifyEmailTransport() {
  const tx = getTransporter();
  if (!tx) {
    console.warn("⚠  Email disabled — GMAIL_USER / GMAIL_APP_PASSWORD not set");
    return false;
  }
  try {
    await tx.verify();
    verified = true;
    console.log("✅ Email service ready (Gmail)");
    return true;
  } catch (error) {
    console.error("❌ Email service failed to connect:", error.message);
    return false;
  }
}

/**
 * Sends one email. Never throws — a single bad address must not abort a batch of
 * expiry notifications, so failures are returned rather than raised.
 */
export async function sendEmail({ to, subject, html }) {
  const tx = getTransporter();

  if (!tx) {
    return { success: false, error: "Email integration is not configured" };
  }

  try {
    const info = await tx.sendMail({
      from: `"TransitOps" <${env.gmailUser}>`,
      to,
      subject,
      html,
    });
    console.log(`[email] sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[email] failed to send to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

export function isEmailVerified() {
  return verified;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const shell = (heading, body) => `
  <div style="font-family: Arial, sans-serif; max-width: 480px;">
    <h2 style="color:#dc2626;">${heading}</h2>
    ${body}
    <p style="color:#6b7280; font-size: 12px; margin-top: 24px;">
      Automated notice — TransitOps Fleet Management.
    </p>
  </div>
`;

export function insuranceExpiredEmail(vehicle, recipientEmail) {
  return {
    to: recipientEmail,
    subject: `⚠ Insurance Expired — ${vehicle.registrationNo}`,
    html: shell(
      "Vehicle Insurance Expired",
      `<p>The insurance for vehicle <strong>${vehicle.registrationNo}</strong> (${vehicle.name})
       ${vehicle.insuranceNumber ? `— policy <strong>${vehicle.insuranceNumber}</strong> —` : ""}
       expired on <strong>${new Date(vehicle.insuranceExpiry).toLocaleDateString()}</strong>.</p>
       <p>This vehicle has been automatically flagged. Please renew the insurance and update
       the record in TransitOps as soon as possible.</p>`
    ),
  };
}

export function pucExpiredEmail(vehicle, recipientEmail) {
  return {
    to: recipientEmail,
    subject: `⚠ PUC Expired — ${vehicle.registrationNo}`,
    html: shell(
      "Vehicle PUC Certificate Expired",
      `<p>The Pollution Under Control certificate for <strong>${vehicle.registrationNo}</strong>
       (${vehicle.name})${vehicle.pucNumber ? ` — <strong>${vehicle.pucNumber}</strong> —` : ""}
       expired on <strong>${new Date(vehicle.pucExpiry).toLocaleDateString()}</strong>.</p>
       <p>Driving without a valid PUC certificate is an offence. Please renew it and update
       the record in TransitOps.</p>`
    ),
  };
}

export function licenseExpiryEmail(driver, daysRemaining) {
  const isExpired = daysRemaining < 0;
  const daysAgo = Math.abs(daysRemaining);

  return {
    to: driver.email,
    subject: isExpired
      ? `⚠ License Expired — ${driver.name}`
      : `⚠ License Expiring in ${daysRemaining} Day${daysRemaining === 1 ? "" : "s"}`,
    html: shell(
      "License Expiry Notice",
      `<p>Hi ${driver.name},</p>
       <p>Your driving license (<strong>${driver.licenseNumber}</strong>)
       ${
         isExpired
           ? `expired on <strong>${new Date(driver.licenseExpiry).toLocaleDateString()}</strong>
              — ${daysAgo} day${daysAgo === 1 ? "" : "s"} ago.`
           : `expires on <strong>${new Date(driver.licenseExpiry).toLocaleDateString()}</strong>
              — ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} from now.`
       }
       </p>
       <p>Please renew it ${isExpired ? "immediately" : "soon"}. Drivers with expired licenses
       cannot be assigned to trips in TransitOps and will be automatically restricted.</p>`
    ),
  };
}

export function serviceDueEmail(vehicle, kmOverdue, recipientEmail) {
  const overdue = kmOverdue > 0;
  return {
    to: recipientEmail,
    subject: `🔧 Service ${overdue ? "Overdue" : "Due Soon"} — ${vehicle.registrationNo}`,
    html: shell(
      overdue ? "Vehicle Service Overdue" : "Vehicle Service Due Soon",
      `<p>Vehicle <strong>${vehicle.registrationNo}</strong> (${vehicle.name}) is at
       <strong>${Math.round(vehicle.odometer).toLocaleString("en-IN")} km</strong>.</p>
       <p>Its service interval is every
       <strong>${Math.round(vehicle.serviceIntervalKm).toLocaleString("en-IN")} km</strong>, and the
       last recorded service was at
       <strong>${Math.round(vehicle.lastServiceOdometer).toLocaleString("en-IN")} km</strong> —
       ${
         overdue
           ? `<strong>${Math.round(kmOverdue).toLocaleString("en-IN")} km overdue</strong>.`
           : `due in <strong>${Math.round(-kmOverdue).toLocaleString("en-IN")} km</strong>.`
       }</p>
       <p>Please schedule a maintenance job in TransitOps.</p>`
    ),
  };
}

export default { sendEmail, verifyEmailTransport, isEmailEnabled };
