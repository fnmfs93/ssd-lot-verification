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

type LabelCodeInput = {
  codeValue: string;
  boxLabel: "first" | "last";
  serialIndex: number;
};

type LabelSessionInput = {
  qaUserId: string;
  qaUserName: string;
  qaStation: string | null;
  sourceType: string;
  sessionIdCode: string;
  partNumber: string;
  firstBoxImageRef: string;
  lastBoxImageRef: string;
  rawOcrText: string;
  codes: LabelCodeInput[];
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
      // Legacy column, kept populated for any old code/reports still
      // reading it — the box-specific refs below are the source of truth.
      imageRef: input.firstBoxImageRef,
      rawOcrText: input.rawOcrText,
      sessionIdCode: input.sessionIdCode,
      partNumber: input.partNumber,
      firstBoxImageRef: input.firstBoxImageRef,
      lastBoxImageRef: input.lastBoxImageRef,
    }),
    ...input.codes.map((code, index) =>
      db.insert(labelCodes).values({
        id: randomUUID(),
        labelSessionId: id,
        codeValue: code.codeValue,
        rowIndex: index,
        boxLabel: code.boxLabel,
        serialIndex: code.serialIndex,
      }),
    ),
    db.insert(auditLog).values({
      id: randomUUID(),
      actorUserId: input.qaUserId,
      eventType: "label_session.created",
      entityType: "label_session",
      entityId: id,
      payload: JSON.stringify({
        codeCount: input.codes.length,
        sourceType: input.sourceType,
        sessionIdCode: input.sessionIdCode,
        partNumber: input.partNumber,
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
      boxLabel: labelCodes.boxLabel,
      serialIndex: labelCodes.serialIndex,
    })
    .from(labelCodes)
    .where(eq(labelCodes.labelSessionId, session.id))
    .orderBy(asc(labelCodes.rowIndex));

  const matchedCodeEntry =
    codes.find((entry) => entry.codeValue === input.scannedQrValue) ?? null;

  const verificationId = randomUUID();
  const result = matchedCodeEntry ? "matched" : "unmatched";
  const verifiedAt = new Date();

  await db.batch([
    db.insert(partVerifications).values({
      id: verificationId,
      labelSessionId: session.id,
      qaUserId: input.qaUserId,
      qaUserName: input.qaUserName,
      scannedQrValue: input.scannedQrValue,
      result,
      matchedLabelCode: matchedCodeEntry?.codeValue ?? null,
      matchedBoxLabel: matchedCodeEntry?.boxLabel ?? null,
      matchedSerialIndex: matchedCodeEntry?.serialIndex ?? null,
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

  // The fixed First-3/Last-3 sampling structure means the session is
  // "complete" once every one of the 6 label codes has been claimed by at
  // least one matched verification — a duplicate scan of an already-claimed
  // code still reports as a match, it just doesn't count toward this.
  const matchedVerifications = await db
    .select({ matchedLabelCode: partVerifications.matchedLabelCode })
    .from(partVerifications)
    .where(eq(partVerifications.labelSessionId, session.id));

  const claimedCodes = new Set(
    matchedVerifications
      .map((entry) => entry.matchedLabelCode)
      .filter((value): value is string => Boolean(value)),
  );

  const sessionComplete =
    codes.length > 0 && codes.every((code) => claimedCodes.has(code.codeValue));

  return {
    id: verificationId,
    scannedQrValue: input.scannedQrValue,
    result: result as "matched" | "unmatched",
    matchedLabelCode: matchedCodeEntry?.codeValue ?? null,
    matchedBoxLabel: matchedCodeEntry?.boxLabel ?? null,
    matchedSerialIndex: matchedCodeEntry?.serialIndex ?? null,
    verifiedAt: verifiedAt.toISOString(),
    sessionComplete,
  };
}

export async function updateSessionRemarks(sessionKey: string, remarks: string) {
  const db = getDb();
  await db
    .update(labelSessions)
    .set({ remarks, updatedAt: new Date() })
    .where(eq(labelSessions.sessionKey, sessionKey));
}

export async function getLabelSessionReportData(sessionKey: string) {
  const db = getDb();
  const [session] = await db
    .select()
    .from(labelSessions)
    .where(eq(labelSessions.sessionKey, sessionKey))
    .limit(1);

  if (!session) {
    return null;
  }

  const codes = await db
    .select()
    .from(labelCodes)
    .where(eq(labelCodes.labelSessionId, session.id))
    .orderBy(asc(labelCodes.rowIndex));

  const verifications = await db
    .select()
    .from(partVerifications)
    .where(eq(partVerifications.labelSessionId, session.id))
    .orderBy(asc(partVerifications.verifiedAt));

  return { session, codes, verifications };
}

export async function markReportSent(sessionId: string, error: string | null) {
  const db = getDb();
  await db
    .update(labelSessions)
    .set({
      reportSentAt: error ? null : new Date(),
      reportEmailError: error,
      updatedAt: new Date(),
    })
    .where(eq(labelSessions.id, sessionId));
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
