import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import { canAdminister } from "./policies.js";

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.auth || !canAdminister(req.auth)) {
      throw new ForbiddenException("Administrator access required");
    }
    return true;
  }
}
