import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  auditLog,
  labelCodes,
  labelSessions,
  partVerifications,
  sessions,
  users,
} from "@/lib/db/schema";

type SessionInsert = {
  token: string;
  userId: string;
  userName: string;
  expiresAt: Date;
};

export async function getUserByEmail(email: string) {
  const db = getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  return user ?? null;
}

export async function verifyPassword(
  password: string,
  passwordHash: string,
  passwordSalt: string,
) {
  const derived = scryptSync(password, passwordSalt, 64);
  const expected = Buffer.from(passwordHash, "hex");
  return timingSafeEqual(derived, expected);
}

export async function createSessionRecord(input: SessionInsert) {
  const db = getDb();
  await db.insert(sessions).values({
    token: input.token,
    userId: input.userId,
    userName: input.userName,
    expiresAt: input.expiresAt,
  });
}

export async function getSessionByToken(token: string) {
  const db = getDb();
  const [session] = await db
    .select({
      token: sessions.token,
      userId: sessions.userId,
      userName: sessions.userName,
      userEmail: users.email,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.token, token))
    .limit(1);

  return session ?? null;
}

export async function deleteSessionByToken(token: string) {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.token, token));
}

type LabelSessionInput = {
  qaUserId: string;
  qaUserName: string;
  qaStation: string | null;
  sourceType: string;
  imageRef: string;
  extractedCodes: string[];
  rawOcrText: string;
};

export async function createLabelSession(input: LabelSessionInput) {
  const db = getDb();
  const id = randomUUID();
  const sessionKey = randomUUID();

  await db.batch([
    db.insert(labelSessions).values({
      id,
      sessionKey,
      qaUserId: input.qaUserId,
      qaUserName: input.qaUserName,
      qaStation: input.qaStation,
      sourceType: input.sourceType,
      imageRef: input.imageRef,
      rawOcrText: input.rawOcrText,
    }),
    ...input.extractedCodes.map((codeValue, index) =>
      db.insert(labelCodes).values({
        id: randomUUID(),
        labelSessionId: id,
        codeValue,
        rowIndex: index,
      }),
    ),
    db.insert(auditLog).values({
      id: randomUUID(),
      actorUserId: input.qaUserId,
      eventType: "label_session.created",
      entityType: "label_session",
      entityId: id,
      payload: JSON.stringify({
        codeCount: input.extractedCodes.length,
        sourceType: input.sourceType,
      }),
    }),
  ]);

  return { id, sessionKey };
}

export async function recordPartVerification(input: {
  qaUserId: string;
  qaUserName: string;
  sessionKey: string;
  scannedQrValue: string;
}) {
  const db = getDb();
  const [session] = await db
    .select({
      id: labelSessions.id,
      sessionKey: labelSessions.sessionKey,
    })
    .from(labelSessions)
    .where(eq(labelSessions.sessionKey, input.sessionKey))
    .limit(1);

  if (!session) {
    return null;
  }

  const codes = await db
    .select({
      codeValue: labelCodes.codeValue,
    })
    .from(labelCodes)
    .where(eq(labelCodes.labelSessionId, session.id))
    .orderBy(asc(labelCodes.rowIndex));

  const matchedCode =
    codes.find((entry) => entry.codeValue === input.scannedQrValue)?.codeValue ?? null;

  const verificationId = randomUUID();
  const result = matchedCode ? "matched" : "unmatched";
  const verifiedAt = new Date();

  await db.batch([
    db.insert(partVerifications).values({
      id: verificationId,
      labelSessionId: session.id,
      qaUserId: input.qaUserId,
      qaUserName: input.qaUserName,
      scannedQrValue: input.scannedQrValue,
      result,
      matchedLabelCode: matchedCode,
      verifiedAt,
    }),
    db.insert(auditLog).values({
      id: randomUUID(),
      actorUserId: input.qaUserId,
      eventType: "part_verification.created",
      entityType: "label_session",
      entityId: session.id,
      payload: JSON.stringify({
        scannedQrValue: input.scannedQrValue,
        result,
      }),
    }),
  ]);

  return {
    id: verificationId,
    scannedQrValue: input.scannedQrValue,
    result: result as "matched" | "unmatched",
    matchedLabelCode: matchedCode,
    verifiedAt: verifiedAt.toISOString(),
  };
}

export async function listSessionVerifications(sessionKey: string) {
  const db = getDb();
  const [session] = await db
    .select({
      id: labelSessions.id,
    })
    .from(labelSessions)
    .where(eq(labelSessions.sessionKey, sessionKey))
    .limit(1);

  if (!session) {
    return [];
  }

  return db
    .select()
    .from(partVerifications)
    .where(eq(partVerifications.labelSessionId, session.id))
    .orderBy(desc(partVerifications.verifiedAt));
}
