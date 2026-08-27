import type { FastifyPluginAsync } from "fastify";
import { config } from "../lib/config.js";
import { requireUser } from "../lib/auth-helpers.js";

export const dbRoutes: FastifyPluginAsync = async (app) => {
  app.get("/phpmyadmin-redirect", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const target = `https://db.${config.PRIMARY_DOMAIN}`;
    reply.redirect(target);
  });

  app.get("/adminer-redirect", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    // ADMINER_URL can be a full URL (e.g. https://adminer.domain.com) or a path
    const target = config.ADMINER_URL
      ? (config.ADMINER_URL.startsWith("http") ? config.ADMINER_URL : `https://${config.PRIMARY_DOMAIN}${config.ADMINER_URL}`)
      : `https://adminer.${config.PRIMARY_DOMAIN}`;
    reply.redirect(target);
  });
};
