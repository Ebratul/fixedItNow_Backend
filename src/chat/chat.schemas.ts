import { z } from "zod";
import { userText } from "../common/user-text.js";

export const MAX_MESSAGE_LENGTH = 2000;
/** A booking conversation is a coordination channel, not an archive: bounded so one pair cannot fill the table. */
export const MAX_MESSAGES_PER_BOOKING = 1000;
export const CHAT_PAGE_SIZE = 100;

export const sendMessageSchema = z
  .object({
    body: userText(1, MAX_MESSAGE_LENGTH, "Message"),
    /** Chosen by the client once per message; resending the same value never creates a second row. */
    clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Use 8-64 letters, digits, '-' or '_'"),
  })
  .strict();
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const listMessagesSchema = z
  .object({
    /** `seq` of the oldest message already shown; returns the page before it. */
    before: z.coerce.number().int().positive().max(2_000_000_000).optional(),
  })
  .strict();
export type ListMessagesQuery = z.infer<typeof listMessagesSchema>;
