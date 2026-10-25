import { Module } from "@nestjs/common";
import { BookingCore } from "../bookings/booking-core.service.js";
import { Clock } from "../bookings/clock.js";
import { ChatController } from "./chat.controller.js";
import { ChatService } from "./chat.service.js";

@Module({
  controllers: [ChatController],
  providers: [Clock, BookingCore, ChatService],
})
export class ChatModule {}
