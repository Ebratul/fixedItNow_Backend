import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service.js";
import { isApprovedWorker } from "./policies.js";

@Injectable()
export class ApprovedWorkerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.auth) throw new ForbiddenException();

    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId: req.auth.userId },
      select: { id: true, userId: true, onboardingStatus: true, verificationStatus: true },
    });
    if (!profile || !isApprovedWorker(profile)) {
      throw new ForbiddenException("An approved worker profile is required");
    }
    req.worker = profile;
    return true;
  }
}
