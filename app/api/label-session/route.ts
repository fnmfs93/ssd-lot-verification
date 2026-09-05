import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { createLabelSession } from "@/lib/db/queries";
import { storeLabelImage } from "@/lib/storage/google-drive";

export const runtime = "nodejs";
export const maxDuration = 30;

const CODE_TOKEN_PATTERN = /^[A-Z0-9]{6,16}$/;
const SESSION_ID_PATTERN = /^\d{8}-\d{4}$/;
const PART_NUMBER_PATTERN = /^[A-Z]\d{3}-\d{6}$/;

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

function resolveBoxCodes(formData: FormData, prefix: "firstBox" | "lastBox") {
  return parseCodeList(String(formData.get(`${prefix}Codes`) ?? "[]"));
}

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const formData = await request.formData();
  const station = String(formData.get("station") ?? "").trim() || null;
  const sourceType = String(formData.get("sourceType") ?? "camera").trim();
  const rawOcrText = String(formData.get("rawOcrText") ?? "");
  const sessionIdCode = String(formData.get("sessionIdCode") ?? "").trim().toUpperCase();
  const partNumber = String(formData.get("partNumber") ?? "").trim().toUpperCase();

  const firstBoxFile = formData.get("firstBoxFile");
  const lastBoxFile = formData.get("lastBoxFile");

  if (!(firstBoxFile instanceof File) || !(lastBoxFile instanceof File)) {
    return NextResponse.json(
      { error: "First Box and Last Box label photos are both required." },
      { status: 400 },
    );
  }

  if (!firstBoxFile.type.startsWith("image/") || !lastBoxFile.type.startsWith("image/")) {
    return NextResponse.json(
      { error: "Version 1 supports image uploads only." },
      { status: 400 },
    );
  }

  if (!SESSION_ID_PATTERN.test(sessionIdCode)) {
    return NextResponse.json(
      { error: "Session ID looks wrong — expected format YYYYMMDD-NNNN, e.g. 20260801-0001." },
      { status: 422 },
    );
  }

  if (!PART_NUMBER_PATTERN.test(partNumber)) {
    return NextResponse.json(
      { error: "Part Number looks wrong — expected format LNNN-NNNNNN, e.g. M034-002816." },
      { status: 422 },
    );
  }

  const firstBoxCodes = resolveBoxCodes(formData, "firstBox");
  const lastBoxCodes = resolveBoxCodes(formData, "lastBox");

  if (!firstBoxCodes.length || !lastBoxCodes.length) {
    return NextResponse.json(
      {
        error: "Couldn't read the 2D codes for one of the boxes. Try scanning again.",
        ocrPreview: rawOcrText.replace(/\s+/g, " ").slice(0, 500),
      },
      { status: 422 },
    );
  }

  const firstBoxBuffer = Buffer.from(await firstBoxFile.arrayBuffer());
  const lastBoxBuffer = Buffer.from(await lastBoxFile.arrayBuffer());

  try {
    const [firstBoxStored, lastBoxStored] = await Promise.all([
      storeLabelImage({
        fileName: firstBoxFile.name,
        mimeType: firstBoxFile.type,
        buffer: firstBoxBuffer,
      }),
      storeLabelImage({
        fileName: lastBoxFile.name,
        mimeType: lastBoxFile.type,
        buffer: lastBoxBuffer,
      }),
    ]);

    const codes = [
      ...firstBoxCodes.map((codeValue, index) => ({
        codeValue,
        boxLabel: "first" as const,
        serialIndex: index + 1,
      })),
      ...lastBoxCodes.map((codeValue, index) => ({
        codeValue,
        boxLabel: "last" as const,
        serialIndex: index + 1,
      })),
    ];

    const session = await createLabelSession({
      qaUserId: user.id,
      qaUserName: user.name,
      qaStation: station,
      sourceType,
      sessionIdCode,
      partNumber,
      firstBoxImageRef: firstBoxStored.fileRef,
      lastBoxImageRef: lastBoxStored.fileRef,
      rawOcrText,
      codes,
      // Kept only long enough to attach to the report email, then deleted —
      // storeLabelImage above is the (currently stub, non-functional)
      // long-term archive.
      photos: [
        { boxLabel: "first", mimeType: firstBoxFile.type, buffer: firstBoxBuffer },
        { boxLabel: "last", mimeType: lastBoxFile.type, buffer: lastBoxBuffer },
      ],
    });

    return NextResponse.json({
      sessionKey: session.sessionKey,
      sessionIdCode,
      partNumber,
      codes: codes.map((code) => code.codeValue),
      firstBoxCodes,
      lastBoxCodes,
      storageMode: firstBoxStored.storageMode,
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
