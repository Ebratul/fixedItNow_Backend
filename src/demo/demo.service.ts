import { Injectable } from "@nestjs/common";
import { SETTINGS } from "../admin/settings/registry.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { DEMO_KEYS, DEMO_PROFILES, demoSettingKey, type DemoKey } from "./demo.config.js";

/** One option as the public login page sees it. Nothing here identifies a user or reveals a setting that is off. */
export type PublicDemoOption = { role: DemoKey; label: string; description: string; available: boolean };

@Injectable()
export class DemoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * What the login page may show: ONLY the options an administrator made visible, each with whether a session can be
   * started right now (`available` = the backend's "allow new demo sessions" switch). A hidden option is absent, with no
   * hint that it exists. Read fresh from the database (not cached), so the page never promises what the API refuses.
   */
  async publicOptions(): Promise<PublicDemoOption[]> {
    const keys = DEMO_KEYS.flatMap((k) => [demoSettingKey(k, "visible"), demoSettingKey(k, "enabled")]);
    const rows = await this.prisma.platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const on = (key: ReturnType<typeof demoSettingKey>) => {
      const parsed = SETTINGS[key].schema.safeParse(stored.get(key));
      return parsed.success ? parsed.data : SETTINGS[key].default;
    };
    return DEMO_KEYS.filter((k) => on(demoSettingKey(k, "visible"))).map((k) => ({
      role: k,
      label: DEMO_PROFILES[k].label,
      description: DEMO_PROFILES[k].description,
      available: on(demoSettingKey(k, "enabled")),
    }));
  }
}
