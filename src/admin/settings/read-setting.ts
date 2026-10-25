import type { PrismaService } from "../../prisma/prisma.service.js";
import { SETTINGS, type SettingKey, type SettingValue } from "./registry.js";

/**
 * Uncached single-setting read for code that runs outside Nest's DI (the authentication hooks).
 * Falls back to the default when nothing is stored or the stored value no longer validates.
 */
export async function readSetting<K extends SettingKey>(prisma: PrismaService, key: K): Promise<SettingValue<K>> {
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  if (row) {
    const parsed = SETTINGS[key].schema.safeParse(row.value);
    if (parsed.success) return parsed.data as SettingValue<K>;
  }
  return SETTINGS[key].default as SettingValue<K>;
}
