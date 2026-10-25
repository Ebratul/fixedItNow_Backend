import { Module } from "@nestjs/common";
import { BookingCore } from "../bookings/booking-core.service.js";
import { Clock } from "../bookings/clock.js";
import { AdminPaymentsController } from "./admin-payments.controller.js";
import { PaymentCallbacksController } from "./payment-callbacks.controller.js";
import { PaymentCallbacksService } from "./payment-callbacks.service.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";
import { HttpClient } from "./providers/http.js";
import { PaymentProviders } from "./providers/providers.service.js";
import { RefundsService } from "./refunds.service.js";

@Module({
  controllers: [PaymentsController, PaymentCallbacksController, AdminPaymentsController],
  providers: [Clock, BookingCore, HttpClient, PaymentProviders, PaymentsService, PaymentCallbacksService, RefundsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
