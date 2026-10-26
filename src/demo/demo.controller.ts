import { Controller, Get, Header } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/decorators.js";
import { DemoService } from "./demo.service.js";

/**
 * The login page's read-only view of the demo options. Public, tiny and cheap, and it exposes nothing else: no user,
 * no setting that is off, no hint of a hidden option. Starting a session is `POST /auth/demo/sign-in` (Better Auth).
 */
@Controller("demo")
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header("Cache-Control", "no-store")
  @Get("options")
  async options() {
    return { options: await this.demo.publicOptions() };
  }
}
