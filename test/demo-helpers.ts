import { DEMO_KEYS, demoSettingKey, type DemoKey } from "../src/demo/demo.config.js";
import { seedDemo } from "../src/demo/demo.fixtures.js";
import { SettingsService } from "../src/admin/settings/settings.service.js";
import type { TestApp } from "./helpers.js";

export type Switches = { visible?: boolean; enabled?: boolean };

/**
 * Sets the demo switches straight in the database (the admin API path is tested in demo-settings). Anything not
 * mentioned is OFF, which is also the production default.
 */
export async function setDemoSwitches(t: TestApp, switches: Partial<Record<DemoKey, Switches>>) {
  for (const key of DEMO_KEYS) {
    for (const field of ["visible", "enabled"] as const) {
      const value = switches[key]?.[field] ?? false;
      await t.prisma.platformSetting.upsert({ where: { key: demoSettingKey(key, field) }, create: { key: demoSettingKey(key, field), value }, update: { value } });
    }
  }
  t.app.get(SettingsService).invalidate();
}

export const allDemoOn = Object.fromEntries(DEMO_KEYS.map((k) => [k, { visible: true, enabled: true }])) as Record<DemoKey, Switches>;

/** The fictional demo data, dated by the test's fake clock. Uses the unscoped client on purpose. */
export const seedDemoData = (t: TestApp) => seedDemo(t.prisma.unscoped, { now: t.clock.now() });

/** POST /auth/demo/sign-in with a fresh cookie jar. Returns the agent and the raw response. */
export async function demoSignIn(t: TestApp, role: string) {
  const agent = t.client();
  const res = await agent.post(`${t.api}/auth/demo/sign-in`).send({ role });
  return { agent, res };
}

/** Signed-in demo agent (throws unless the sign-in worked). */
export async function demoSession(t: TestApp, role: DemoKey) {
  const { agent, res } = await demoSignIn(t, role);
  if (res.status !== 200) throw new Error(`demo sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  const me = await agent.get(`${t.api}/me`);
  return { agent, userId: me.body.user.id as string, me: me.body };
}
