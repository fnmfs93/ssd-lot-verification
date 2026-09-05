import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import {
  deleteLabelSessionPhotos,
  getLabelSessionPhotos,
  getLabelSessionReportData,
  markReportSent,
  updateSessionRemarks,
} from "@/lib/db/queries";
import { buildReportRows, sendVerificationReport } from "@/lib/email/report";

export const runtime = "nodejs";
export const maxDuration = 30;

const schema = z.object({
  sessionKey: z.string().min(10),
  outcome: z.enum(["pass", "fail"]),
  remarks: z.string().trim().max(500).optional(),
});

// Two uses: (1) QA deliberately closes out a session as FAILED (e.g. a
// scanned part clearly doesn't belong) without waiting for all 6 slots to
// be filled, since the auto-send path only fires once every slot matches;
// (2) retrying a report send that failed the first time (e.g. email wasn't
// configured yet), for either outcome.
export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid session key." }, { status: 400 });
  }

  if (parsed.data.remarks !== undefined) {
    await updateSessionRemarks(parsed.data.sessionKey, parsed.data.remarks);
  }

  const report = await getLabelSessionReportData(parsed.data.sessionKey);

  if (!report) {
    return NextResponse.json({ error: "Label session not found." }, { status: 404 });
  }

  if (report.session.reportSentAt) {
    return NextResponse.json(
      { error: "A report was already sent for this session." },
      { status: 409 },
    );
  }

  try {
    const photos = await getLabelSessionPhotos(report.session.id);

    await sendVerificationReport({
      sessionIdCode: report.session.sessionIdCode ?? report.session.sessionKey,
      partNumber: report.session.partNumber ?? "-",
      qaUserName: report.session.qaUserName,
      outcome: parsed.data.outcome,
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
    return NextResponse.json({ reportSent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send report email.";
    await markReportSent(report.session.id, message);
    return NextResponse.json({ reportSent: false, error: message }, { status: 502 });
  }
}
