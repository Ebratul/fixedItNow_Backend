import { Global, Module } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";
import { MailService } from "../mail/mail.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AdminGuard } from "./admin.guard.js";
import { ApprovedWorkerGuard } from "./approved-worker.guard.js";
import { AUTH, createAuth } from "./auth.factory.js";
import { AuthGuard } from "./auth.guard.js";
import { OriginGuard } from "./origin.guard.js";

@Global()
@Module({
  providers: [
    {
      provide: AUTH,
      inject: [ENV, PrismaService, MailService],
      useFactory: (env: Env, prisma: PrismaService, mail: MailService) =>
        createAuth(env, prisma, mail),
    },
    AuthGuard,
    OriginGuard,
    AdminGuard,
    ApprovedWorkerGuard,
  ],
  exports: [AUTH, AuthGuard, OriginGuard, AdminGuard, ApprovedWorkerGuard],
})
export class AuthModule {}
