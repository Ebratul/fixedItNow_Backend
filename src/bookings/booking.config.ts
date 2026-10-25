/**
 * Booking policy constants. They are code, not environment, because changing
 * them changes documented behaviour (see docs/BOOKINGS.md) and tests.
 */
export const BOOKING_TIMEZONE = "Asia/Dhaka";

/** Appointments start on a 30-minute grid and last a multiple of it. */
export const SLOT_MINUTES = 30;
export const MIN_DURATION_MINUTES = 30;
export const MAX_DURATION_MINUTES = 480;

/** A new request/reschedule must start at least this far ahead. */
export const MIN_LEAD_MINUTES = 120;
export const MAX_ADVANCE_DAYS = 90;

/** A worker may start a confirmed job this long before its scheduled start. */
export const START_EARLY_MINUTES = 30;
/** ...and may still report arriving / start it this long after the scheduled end (24 h). */
export const START_WINDOW_AFTER_END_MINUTES = 24 * 60;

export const QUOTE_DEFAULT_VALID_HOURS = 48;
export const QUOTE_MAX_VALID_HOURS = 168;
export const RESCHEDULE_VALID_HOURS = 48;

/** Cancelling a confirmed booking this close to its start is recorded as "late". */
export const LATE_CANCELLATION_HOURS = 24;

/** A booking can be disputed this long after completion. */
export const DISPUTE_WINDOW_DAYS = 14;

/** Abuse guard: a customer's simultaneous open requests. */
export const MAX_OPEN_REQUESTS_PER_CUSTOMER = 20;

export const MAX_QUOTE_COMPONENT_BDT = 1_000_000;
export const MAX_AVAILABILITY_WINDOWS = 28;
export const MAX_TIME_OFF_DAYS = 90;
