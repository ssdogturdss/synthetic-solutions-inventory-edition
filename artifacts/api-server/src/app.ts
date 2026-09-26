import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { startPushNotificationWorker } from "./lib/push-notifications";

const app: Express = express();

function getCorsOrigins(): string[] {
  const configured = process.env.CORS_ORIGIN;
  if (!configured && process.env.NODE_ENV !== "production") return ["*"];
  if (!configured) {
    throw new Error(
      "CORS_ORIGIN must be set in production to one or more comma-separated HTTPS origins.",
    );
  }

  const origins = configured.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0 || origins.includes("*")) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CORS_ORIGIN must not contain '*' in production; configure trusted HTTPS origins.");
    }
    return ["*"];
  }

  return origins.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS_ORIGIN "${origin}": expected an absolute HTTPS origin.`);
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      origin !== parsed.origin &&
      origin !== `${parsed.origin}/`
    ) {
      throw new Error(
        `Invalid CORS_ORIGIN "${origin}": expected an absolute HTTPS origin without credentials, path, query, or fragment.`,
      );
    }
    return parsed.origin;
  });
}

const configuredCorsOrigins = getCorsOrigins();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(
  cors({
    // Native Expo clients do not send an Origin header. Browser clients do;
    // production is restricted to explicitly configured HTTPS origins.
    origin: (origin, callback) => {
      if (!origin || configuredCorsOrigins.includes("*") || configuredCorsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

startPushNotificationWorker();

export default app;
