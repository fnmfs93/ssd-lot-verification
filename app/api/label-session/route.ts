import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { createLabelSession } from "@/lib/db/queries";
import { storeLabelImage } from "@/lib/storage/google-drive";

export const runtime = "nodejs";
export const maxDuration = 30;

const CODE_TOKEN_PATTERN = /^[A-Z0-9]{6,16}$/;

function parseCodeList(value: string) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const codes = parsed
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => CODE_TOKEN_PATTERN.test(item));

  return [...new Set(codes)];
}

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  const station = String(formData.get("station") ?? "").trim() || null;
  const sourceType = String(formData.get("sourceType") ?? "upload").trim();
  // OCR now runs client-side (lib/ocr/browser-ocr.ts) — the browser scans the
  // label live and sends back whatever codes it already found, plus the
  // manual-entry fallback codes and the raw OCR text for the audit trail.
  const clientCodes = parseCodeList(String(formData.get("codes") ?? "[]"));
  const manualCodes = parseCodeList(
    JSON.stringify(
      String(formData.get("manualCodes") ?? "")
        .toUpperCase()
        .match(/\b[A-Z0-9]{11}\b/g) ?? [],
    ),
  );
  const rawOcrText = String(formData.get("rawOcrText") ?? "");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Label image is required." }, { status: 400 });
  }

  if (!file.type.startsWith("image/")) {
    return NextResponse.json(
      { error: "Version 1 supports image uploads only." },
      { status: 400 },
    );
  }

  const finalCodes = clientCodes.length ? clientCodes : manualCodes;

  if (!finalCodes.length) {
    return NextResponse.json(
      {
        error:
          "No 11-character label codes were found. Try scanning again with the code column filling the guide box, or paste the codes manually below.",
        ocrPreview: rawOcrText.replace(/\s+/g, " ").slice(0, 500),
      },
      { status: 422 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const storedFile = await storeLabelImage({
      fileName: file.name,
      mimeType: file.type,
      buffer,
    });

    const session = await createLabelSession({
      qaUserId: user.id,
      qaUserName: user.name,
      qaStation: station,
      sourceType,
      imageRef: storedFile.fileRef,
      extractedCodes: finalCodes,
      rawOcrText,
    });

    return NextResponse.json({
      sessionKey: session.sessionKey,
      codes: finalCodes,
      imageRef: storedFile.fileRef,
      storageMode: storedFile.storageMode,
      ocrPreview: rawOcrText.replace(/\s+/g, " ").slice(0, 500),
    });
  } catch (error) {
    console.error("label-session processing failed", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Label processing failed.",
      },
      { status: 500 },
    );
  }
}
