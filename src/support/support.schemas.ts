import { z } from "zod";
import { userText } from "../common/user-text.js";

export const TICKET_CATEGORIES = ["GENERAL", "BOOKING", "PAYMENT", "ACCOUNT", "WORKER_COMPLAINT", "CUSTOMER_COMPLAINT", "SAFETY", "OTHER"] as const;
export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_FOR_USER", "RESOLVED", "CLOSED"] as const;
export const TICKET_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type TicketStatusName = (typeof TICKET_STATUSES)[number];

/** Complaints are tickets about a specific booking, so the other party can be identified by staff. */
export const COMPLAINT_CATEGORIES: readonly string[] = ["WORKER_COMPLAINT", "CUSTOMER_COMPLAINT"];
export const MAX_OPEN_TICKETS = 5;

/** Admin-set lifecycle. CLOSED is final; a user reply reopens RESOLVED / WAITING_FOR_USER tickets. */
export const TICKET_TRANSITIONS: Record<TicketStatusName, readonly TicketStatusName[]> = {
  OPEN: ["IN_PROGRESS", "WAITING_FOR_USER", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["OPEN", "WAITING_FOR_USER", "RESOLVED", "CLOSED"],
  WAITING_FOR_USER: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"],
  RESOLVED: ["OPEN", "CLOSED"],
  CLOSED: [],
};

export const createTicketSchema = z
  .strictObject({
    category: z.enum(TICKET_CATEGORIES),
    subject: userText(3, 140, "Subject"),
    body: userText(10, 4000, "Message"),
    bookingId: z.uuid().optional(),
  })
  .refine((t) => !COMPLAINT_CATEGORIES.includes(t.category) || Boolean(t.bookingId), {
    path: ["bookingId"],
    message: "Choose the booking this complaint is about",
  });
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const messageSchema = z.strictObject({ body: userText(1, 4000, "Message") });

export const ticketListSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
