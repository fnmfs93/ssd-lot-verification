import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import {
  deleteLabelSessionPhotos,
  getLabelSessionPhotos,
  getLabelSessionReportData,
  markReportSent,
  recordPartVerification,
  updateSessionRemarks,
} from "@/lib/db/queries";
import { buildReportRows, sendVerificationReport } from "@/lib/email/report";

export const runtime = "nodejs";
export const maxDuration = 30;

const schema = z.object({
  sessionKey: z.string().min(10),
  scannedQrValue: z
    .string()
    .trim()
    .min(3)
    .transform((value) => value.toUpperCase()),
  remarks: z.string().trim().max(500).optional(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a valid session key and QR value." },
      { status: 400 },
    );
  }

  if (parsed.data.remarks !== undefined) {
    await updateSessionRemarks(parsed.data.sessionKey, parsed.data.remarks);
  }

  const result = await recordPartVerification({
    qaUserId: user.id,
    qaUserName: user.name,
    sessionKey: parsed.data.sessionKey,
    scannedQrValue: parsed.data.scannedQrValue,
  });

  if (!result) {
    return NextResponse.json(
      { error: "Label session not found." },
      { status: 404 },
    );
  }

  let reportSent = false;
  let reportError: string | null = null;

  if (result.sessionComplete) {
    const report = await getLabelSessionReportData(parsed.data.sessionKey);

    if (report) {
      try {
        const photos = await getLabelSessionPhotos(report.session.id);

        await sendVerificationReport({
          sessionIdCode: report.session.sessionIdCode ?? report.session.sessionKey,
          partNumber: report.session.partNumber ?? "-",
          qaUserName: report.session.qaUserName,
          outcome: "pass",
          remarks: report.session.remarks ?? "",
          rows: buildReportRows(report.codes, report.verifications),
          attachments: photos.map((photo) => ({
            boxLabel: photo.boxLabel === "first" ? "first" : "last",
            mimeType: photo.mimeType,
            data: photo.data,
          })),
        });
        await markReportSent(report.session.id, null);
        await deleteLabelSessionPhotos(report.session.id);
        reportSent = true;
      } catch (error) {
        reportError = error instanceof Error ? error.message : "Failed to send report email.";
        await markReportSent(report.session.id, reportError);
      }
    }
  }

  return NextResponse.json({ ...result, reportSent, reportError });
}
