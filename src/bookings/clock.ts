import { Injectable } from "@nestjs/common";

/** Injectable time source so tests can move time instead of sleeping. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
