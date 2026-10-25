import { Injectable } from "@nestjs/common";
import type { AuthContext } from "../../auth/auth.types.js";
import { conflict } from "../../bookings/domain-errors.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { BadRequestException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import { SETTINGS, SETTING_KEYS, isSettingKey, type SettingKey, type SettingValue } from "./registry.js";

const CACHE_MS = 5_000;

/**
 * Typed access to platform settings. Reads are cached in memory for a few seconds (the maintenance
 * guard runs on every write request) and the cache is dropped on every change made through this
 * process; with several instances a change reaches the others within CACHE_MS.
 */
@Injectable()
export class SettingsService {
  private cache: { at: number; values: Map<string, unknown> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async load(): Promise<Map<string, unknown>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.values;
    const rows = await this.prisma.platformSetting.findMany();
    const values = new Map<string, unknown>();
    for (const row of rows) {
      if (!isSettingKey(row.key)) continue; // a key removed from the registry is ignored
      const parsed = SETTINGS[row.key].schema.safeParse(row.value);
      if (parsed.success) values.set(row.key, parsed.data); // a stored value that no longer validates falls back to the default
    }
    this.cache = { at: Date.now(), values };
    return values;
  }

  /** Drops the in-memory cache (after a change, and between test cases). */
  invalidate() {
    this.cache = null;
  }

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const values = await this.load();
    return (values.has(key) ? values.get(key) : SETTINGS[key].default) as SettingValue<K>;
  }

  /** Values the web app may see before sign-in (banner, closed registration, assistant availability). */
  async publicConfig() {
    const values = await this.load();
    const read = <K extends SettingKey>(key: K) => (values.has(key) ? values.get(key) : SETTINGS[key].default) as SettingValue<K>;
    return {
      maintenanceMode: read("platform.maintenanceMode"),
      maintenanceMessage: read("platform.maintenanceMessage"),
      registrationsOpen: read("platform.registrationsOpen"),
      assistantEnabled: read("ai.assistantEnabled"),
    };
  }

  async list() {
    const rows = await this.prisma.platformSetting.findMany();
    const stored = new Map(rows.map((r) => [r.key, r]));
    const values = await this.load();
    return SETTING_KEYS.map((key) => {
      const def = SETTINGS[key];
      const row = stored.get(key);
      return {
        key,
        group: def.group,
        label: def.label,
        description: def.description,
        effect: def.effect,
        type: typeof def.default === "boolean" ? ("boolean" as const) : typeof def.default === "number" ? ("number" as const) : ("string" as const),
        value: values.has(key) ? values.get(key) : def.default,
        default: def.default,
        isDefault: !values.has(key),
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async update(admin: AuthContext, key: string, value: unknown, reason: string) {
    if (!isSettingKey(key)) throw new BadRequestException("Unknown setting");
    const parsed = SETTINGS[key].schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        errors: [{ path: "value", message: parsed.error.issues[0]?.message ?? "Invalid value" }],
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.platformSetting.findUnique({ where: { key } });
      const previous = before && SETTINGS[key].schema.safeParse(before.value).success ? before.value : SETTINGS[key].default;
      if (JSON.stringify(previous) === JSON.stringify(parsed.data)) {
        throw conflict("NO_CHANGE", "That is already the current value");
      }
      await tx.platformSetting.upsert({
        where: { key },
        create: { key, value: parsed.data as never, updatedById: admin.userId },
        update: { value: parsed.data as never, updatedById: admin.userId },
      });
      await this.audit.record(tx, {
        actorId: admin.userId,
        action: "setting.update",
        targetType: "PlatformSetting",
        targetId: key,
        metadata: { from: previous, to: parsed.data, reason },
      });
    });
    this.invalidate();
    return (await this.list()).find((s) => s.key === key)!;
  }
}
