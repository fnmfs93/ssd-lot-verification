import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  userName: text("user_name").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const labelSessions = sqliteTable("label_sessions", {
  id: text("id").primaryKey(),
  sessionKey: text("session_key").notNull().unique(),
  qaUserId: text("qa_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  qaUserName: text("qa_user_name").notNull(),
  qaStation: text("qa_station"),
  sourceType: text("source_type").notNull(),
  imageRef: text("image_ref").notNull(),
  rawOcrText: text("raw_ocr_text").notNull(),
  ocrStatus: text("ocr_status").notNull().default("processed"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const labelCodes = sqliteTable("label_codes", {
  id: text("id").primaryKey(),
  labelSessionId: text("label_session_id")
    .notNull()
    .references(() => labelSessions.id, { onDelete: "cascade" }),
  codeValue: text("code_value").notNull(),
  rowIndex: integer("row_index").notNull(),
});

export const partVerifications = sqliteTable("part_verifications", {
  id: text("id").primaryKey(),
  labelSessionId: text("label_session_id")
    .notNull()
    .references(() => labelSessions.id, { onDelete: "cascade" }),
  qaUserId: text("qa_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  qaUserName: text("qa_user_name").notNull(),
  scannedQrValue: text("scanned_qr_value").notNull(),
  result: text("result").notNull(),
  matchedLabelCode: text("matched_label_code"),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});
