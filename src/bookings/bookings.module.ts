import { Module } from "@nestjs/common";
import { AdminDisputesController } from "./admin-disputes.controller.js";
import { AvailabilityController } from "./availability.controller.js";
import { AvailabilityService } from "./availability.service.js";
import { BookingCore } from "./booking-core.service.js";
import { BookingsController } from "./bookings.controller.js";
import { BookingsService } from "./bookings.service.js";
import { Clock } from "./clock.js";
import { DisputesService } from "./disputes.service.js";
import { QuotesService } from "./quotes.service.js";
import { RescheduleService } from "./reschedule.service.js";

@Module({
  controllers: [BookingsController, AvailabilityController, AdminDisputesController],
  providers: [
    Clock,
    AvailabilityService,
    BookingCore,
    BookingsService,
    QuotesService,
    RescheduleService,
    DisputesService,
  ],
})
export class BookingsModule {}
