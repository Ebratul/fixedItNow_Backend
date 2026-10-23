import type { NestExpressApplication } from "@nestjs/platform-express";
import { toNodeHandler } from "better-auth/node";
import helmet from "helmet";
import { AUTH, AUTH_BASE_PATH, type Auth } from "./auth/auth.factory.js";
import { ENV, type Env } from "./config/env.js";

/**
 * Shared by main.ts and the tests so both exercise identical wiring.
 * The app must be created with `{ bodyParser: false }`.
 */
export function configureApp(app: NestExpressApplication) {
  const env = app.get<Env>(ENV);
  const auth = app.get<Auth>(AUTH);

  app.set("trust proxy", env.TRUST_PROXY);
  app.disable("x-powered-by");
  app.use(helmet());
  app.setGlobalPrefix("api/v1", { exclude: [] });

  // Better Auth must read the raw body itself, so it is mounted BEFORE the
  // JSON body parser. Express 5 wildcard syntax.
  app.getHttpAdapter().getInstance().all(`${AUTH_BASE_PATH}/*splat`, toNodeHandler(auth));

  app.useBodyParser("json", { limit: "100kb" });
}
