import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { createLabelSession } from "@/lib/db/queries";
import { extractCodesFromLabelBuffer } from "@/lib/ocr/extract-codes";
import { storeLabelImage } from "@/lib/storage/google-drive";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseManualCodes(value: string) {
  return [...new Set(value.toUpperCase().match(/\b[A-Z0-9]{11}\b/g) ?? [])];
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
  const manualCodes = parseManualCodes(String(formData.get("manualCodes") ?? ""));

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Label image is required." }, { status: 400 });
  }

  if (!file.type.startsWith("image/")) {
    return NextResponse.json(
      { error: "Version 1 supports image uploads only." },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const storedFile = await storeLabelImage({
    fileName: file.name,
    mimeType: file.type,
    buffer,
  });

  const extraction = await extractCodesFromLabelBuffer(buffer);
  const finalCodes = extraction.codes.length ? extraction.codes : manualCodes;

  if (!finalCodes.length) {
    return NextResponse.json(
      {
        error:
          "No 11-character label codes were extracted. Try a clearer photo, or paste the codes manually below the upload box.",
        ocrPreview: extraction.textPreview,
        imageRef: storedFile,
      },
      { status: 422 },
    );
  }

  const session = await createLabelSession({
    qaUserId: user.id,
    qaUserName: user.name,
    qaStation: station,
    sourceType,
    imageRef: storedFile.fileRef,
    extractedCodes: finalCodes,
    rawOcrText: extraction.rawText,
  });

  return NextResponse.json({
    sessionKey: session.sessionKey,
    codes: finalCodes,
    imageRef: storedFile.fileRef,
    storageMode: storedFile.storageMode,
    ocrPreview: extraction.textPreview,
  });
}
