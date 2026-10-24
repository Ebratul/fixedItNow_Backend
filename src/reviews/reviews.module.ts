import { Module } from "@nestjs/common";
import { Clock } from "../bookings/clock.js";
import { ReviewsController } from "./reviews.controller.js";
import { ReviewsService } from "./reviews.service.js";

@Module({
  controllers: [ReviewsController],
  providers: [Clock, ReviewsService],
})
export class ReviewsModule {}
