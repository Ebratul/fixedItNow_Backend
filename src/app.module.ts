import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AdminModule } from "./admin/admin.module.js";
import { MaintenanceGuard } from "./admin/maintenance.guard.js";
import { AiModule } from "./ai/ai.module.js";
import { CommunityModule } from "./community/community.module.js";
import { ReviewsModule } from "./reviews/reviews.module.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthModule } from "./auth/auth.module.js";
import { OriginGuard } from "./auth/origin.guard.js";
import { BookingsModule } from "./bookings/bookings.module.js";
import { ChatModule } from "./chat/chat.module.js";
import { CategoriesController } from "./categories/categories.controller.js";
import { ConfigModule } from "./config/config.module.js";
import { ENV, type Env } from "./config/env.js";
import { HealthController } from "./health/health.controller.js";
import { MailModule } from "./mail/mail.module.js";
import { MeController } from "./me/me.controller.js";
import { MeService } from "./me/me.service.js";
import { FavoritesController } from "./favorites/favorites.controller.js";
import { FavoritesService } from "./favorites/favorites.service.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { WorkersController } from "./workers/workers.controller.js";
import { WorkersService } from "./workers/workers.service.js";
import { WorkerController } from "./worker/worker.controller.js";
import { WorkerDocumentsController } from "./worker/worker-documents.controller.js";
import { WorkerProfileService } from "./worker/worker-profile.service.js";

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    MailModule,
    AuthModule,
    AdminModule,
    BookingsModule,
    ChatModule,
    PaymentsModule,
    AiModule,
    ReviewsModule,
    CommunityModule,
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        // Generous per-IP default for app endpoints; auth endpoints have
        // stricter, dedicated limits inside Better Auth.
        throttlers: [{ ttl: 60_000, limit: 120 }],
        skipIf: () => !env.RATE_LIMIT_ENABLED,
      }),
    }),
  ],
  controllers: [
    HealthController,
    CategoriesController,
    MeController,
    WorkerController,
    WorkersController,
    FavoritesController,
    WorkerDocumentsController,
  ],
  providers: [
    MeService,
    WorkerProfileService,
    WorkersService,
    FavoritesService,
    // Execution order: origin (CSRF) -> throttle -> authenticate. Authorization
    // guards (admin / approved worker) run after these, per route.
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    // After authentication: maintenance mode refuses non-admin writes.
    { provide: APP_GUARD, useClass: MaintenanceGuard },
  ],
})
export class AppModule {}
