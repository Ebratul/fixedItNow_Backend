import { BadRequestException, type PipeTransform } from "@nestjs/common";

/**
 * Better Auth creates user (and session) ids itself: short random alphanumeric strings, not UUIDs.
 * This validates their shape in route params so a malformed id never reaches a query.
 */
export class AuthIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) throw new BadRequestException("Invalid id");
    return value;
  }
}
