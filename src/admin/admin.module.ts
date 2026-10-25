import { Global, Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { AnnouncementsReader } from "../notifications/announcements.reader.js";
import { NotificationsController } from "../notifications/notifications.controller.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { SupportController } from "../support/support.controller.js";
import { SupportService } from "../support/support.service.js";
import { WorkerDocumentsService } from "../worker/worker-documents.service.js";
import { AdminBootstrapService } from "./bootstrap/admin-bootstrap.service.js";
import { AuditController } from "./audit/audit.controller.js";
import { AuditQueryService } from "./audit/audit-query.service.js";
import { AuditService } from "./audit/audit.service.js";
import { AdminBookingsController } from "./bookings/admin-bookings.controller.js";
import { AdminBookingsService } from "./bookings/admin-bookings.service.js";
import { FinanceController } from "./finance/finance.controller.js";
import { FinanceService } from "./finance/finance.service.js";
import { CategoriesAdminController } from "./categories/categories.controller.js";
import { CategoriesAdminService } from "./categories/categories.service.js";
import { KnowledgeAdminController } from "./ai/knowledge.controller.js";
import { KnowledgeAdminService } from "./ai/knowledge.service.js";
import { AnnouncementsAdminController } from "./notifications/announcements.controller.js";
import { AnnouncementsAdminService } from "./notifications/announcements.service.js";
import { AdminSupportController } from "./support/admin-support.controller.js";
import { AdminSupportService } from "./support/admin-support.service.js";
import { ContentController } from "./content/content.controller.js";
import { ContentService } from "./content/content.service.js";
import { DashboardController } from "./dashboard/dashboard.controller.js";
import { DashboardService } from "./dashboard/dashboard.service.js";
import { OpsController } from "./ops/ops.controller.js";
import { RolesController } from "./roles/roles.controller.js";
import { RolesService } from "./roles/roles.service.js";
import { SettingsController } from "./settings/settings.controller.js";
import { SettingsService } from "./settings/settings.service.js";
import { UsersController } from "./users/users.controller.js";
import { UsersService } from "./users/users.service.js";
import { AdminWorkersController } from "./workers/admin-workers.controller.js";
import { AdminWorkersService } from "./workers/admin-workers.service.js";

/**
 * The admin panel's back end. Global so the few cross-cutting services (audit, settings,
 * notifications, document storage) can be injected by feature modules without import cycles.
 * Every controller here declares its permissions with @RequirePermission; a test enforces it.
 */
@Global()
@Module({
  imports: [AiModule],
  controllers: [NotificationsController, SupportController, SettingsController, AuditController, RolesController, UsersController, AdminWorkersController, CategoriesAdminController, AdminBookingsController, FinanceController, DashboardController, OpsController, AdminSupportController, AnnouncementsAdminController, ContentController, KnowledgeAdminController],
  providers: [
    AdminBootstrapService, AuditService, AuditQueryService, SettingsService, NotificationsService, AnnouncementsReader, SupportService, WorkerDocumentsService,
    RolesService, UsersService, AdminWorkersService, CategoriesAdminService, AdminBookingsService, FinanceService, DashboardService, AdminSupportService, AnnouncementsAdminService, ContentService, KnowledgeAdminService,
  ],
  exports: [AuditService, SettingsService, NotificationsService, WorkerDocumentsService],
})
export class AdminModule {}
