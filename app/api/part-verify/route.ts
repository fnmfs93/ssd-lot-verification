import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { recordPartVerification } from "@/lib/db/queries";

export const runtime = "nodejs";

const schema = z.object({
  sessionKey: z.string().min(10),
  scannedQrValue: z
    .string()
    .trim()
    .min(3)
    .transform((value) => value.toUpperCase()),
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

  return NextResponse.json(result);
}
