// Vercel serverless handler (bundled by scripts/bundle-vercel.mjs). Local/container deployments keep using src/main.ts.
// Builds the Nest app once per warm instance and hands every request to its Express instance.
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../dist/app.module.js";
import { configureApp } from "../dist/app.setup.js";

let ready;

async function boot() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance();
}

export default async function handler(req, res) {
  ready ??= boot().catch((error) => {
    ready = undefined; // do not cache a failed start-up
    throw error;
  });
  const server = await ready;
  return server(req, res);
}
