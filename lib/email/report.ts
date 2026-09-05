import nodemailer from "nodemailer";

export type ReportRow = {
  box: "First Box" | "Last Box";
  serialIndex: number;
  serialNumber: string | null;
  status: "MATCH" | "UNMATCH" | "PENDING";
};

export type ReportData = {
  sessionIdCode: string;
  partNumber: string;
  qaUserName: string;
  outcome: "pass" | "fail";
  remarks: string;
  rows: ReportRow[];
};

export function buildReportRows(
  codes: Array<{ codeValue: string; boxLabel: string | null; serialIndex: number | null }>,
  verifications: Array<{ matchedLabelCode: string | null; scannedQrValue: string; result: string }>,
): ReportRow[] {
  return codes
    .filter(
      (code): code is { codeValue: string; boxLabel: string; serialIndex: number } =>
        Boolean(code.boxLabel) && code.serialIndex !== null,
    )
    .sort((left, right) => {
      if (left.boxLabel !== right.boxLabel) {
        return left.boxLabel === "first" ? -1 : 1;
      }

      return left.serialIndex - right.serialIndex;
    })
    .map((code) => {
      const match = verifications.find(
        (entry) => entry.matchedLabelCode === code.codeValue && entry.result === "matched",
      );

      return {
        box: code.boxLabel === "first" ? "First Box" : "Last Box",
        serialIndex: code.serialIndex,
        serialNumber: match ? match.scannedQrValue : null,
        status: match ? "MATCH" : "PENDING",
      };
    });
}

function getRecipients() {
  return (process.env.REPORT_RECIPIENTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      "Email is not configured: set GMAIL_USER and GMAIL_APP_PASSWORD to enable report sending.",
    );
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

function statusColor(status: ReportRow["status"]) {
  if (status === "MATCH") return "#1f9d55";
  if (status === "UNMATCH") return "#d64545";
  return "#8a8a8a";
}

function buildHtml(data: ReportData) {
  const rows = data.rows
    .map(
      (row) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;">${row.box}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;">Serial No. ${row.serialIndex}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;font-family:monospace;">${
          row.serialNumber ?? "-"
        }</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;color:${statusColor(
          row.status,
        )};font-weight:600;">${row.status}</td>
      </tr>`,
    )
    .join("");

  const resultColor = data.outcome === "pass" ? "#1f9d55" : "#d64545";
  const resultLabel = data.outcome === "pass" ? "PASS" : "FAIL";

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;max-width:640px;">
      <p>A barcode verification record has been submitted.</p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Session ID</td><td>${data.sessionIdCode}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Model / Part Number</td><td>${data.partNumber}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Verified By QA</td><td>${data.qaUserName}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Overall Result</td><td style="color:${resultColor};font-weight:700;">${resultLabel}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:600;">Remarks</td><td>${data.remarks || "-"}</td></tr>
      </table>
      <table style="border-collapse:collapse;width:100%;">
        <thead>
          <tr style="background:#eef3ee;text-align:left;">
            <th style="padding:8px 12px;">Box</th>
            <th style="padding:8px 12px;">Item</th>
            <th style="padding:8px 12px;">Serial Number</th>
            <th style="padding:8px 12px;">Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

export async function sendVerificationReport(data: ReportData) {
  const recipients = getRecipients();

  if (!recipients.length) {
    throw new Error("REPORT_RECIPIENTS is not configured — no recipients to send to.");
  }

  const transport = getTransport();
  const subjectTag = data.outcome === "pass" ? "PASS" : "FAIL";

  await transport.sendMail({
    from: process.env.GMAIL_USER,
    to: recipients,
    subject: `[${subjectTag}] QA Barcode Verification - ${data.sessionIdCode}`,
    html: buildHtml(data),
  });
}
