import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { createLabelSession } from "@/lib/db/queries";
import { extractCodesFromLabelBuffer } from "@/lib/ocr/extract-codes";
import { storeLabelImage } from "@/lib/storage/google-drive";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  const station = String(formData.get("station") ?? "").trim() || null;
  const sourceType = String(formData.get("sourceType") ?? "upload").trim();

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

  if (!extraction.codes.length) {
    return NextResponse.json(
      {
        error:
          "No 11-character label codes were extracted. Try a clearer photo with less glare.",
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
    extractedCodes: extraction.codes,
    rawOcrText: extraction.rawText,
  });

  return NextResponse.json({
    sessionKey: session.sessionKey,
    codes: extraction.codes,
    imageRef: storedFile.fileRef,
    storageMode: storedFile.storageMode,
    ocrPreview: extraction.textPreview,
  });
}
