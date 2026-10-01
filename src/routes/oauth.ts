import type { FastifyInstance } from "fastify";
import { pkceChallenge, randomToken } from "../crypto.js";
import { getConnector } from "../platforms/index.js";

export function redirectUri(publicBaseUrl: string, connectorId: string): string {
  return `${publicBaseUrl}/oauth/${connectorId}/callback`;
}

/** Browser-facing OAuth flow: /connect/:connector → platform login → /oauth/:connector/callback. */
export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  const { config, db, auth, accounts } = app.services;

  const backToAccounts = (params: Record<string, string>) =>
    `${config.publicBaseUrl}/#accounts?${new URLSearchParams(params).toString()}`;

  app.get<{ Params: { connector: string } }>("/connect/:connector", async (req, reply) => {
    if (!auth.isAuthenticated(req)) return reply.redirect("/");
    const connector = getConnector(req.params.connector);
    if (!connector || connector.kind !== "oauth") return reply.code(404).send({ error: "Unknown connector" });
    if (!connector.isConfigured(config)) {
      return reply.redirect(
        backToAccounts({ error: `${connector.name} isn't set up yet. Add ${connector.envVars.join(" and ")} to the server's .env and restart.` }),
      );
    }
    const state = randomToken();
    const verifier = connector.usesPkce ? randomToken(48) : null;
    db.saveOAuthState(state, connector.id, verifier);
    const url = connector.authorizeUrl!(config, {
      state,
      redirectUri: redirectUri(config.publicBaseUrl, connector.id),
      codeChallenge: verifier ? pkceChallenge(verifier) : null,
    });
    return reply.redirect(url);
  });

  // Validated by the single-use `state` created above (only a logged-in user can create one), so this
  // works even if the dashboard was opened on a different host than PUBLIC_BASE_URL.
  app.get<{ Params: { connector: string }; Querystring: Record<string, string> }>("/oauth/:connector/callback", async (req, reply) => {
    const connector = getConnector(req.params.connector);
    const q = req.query;
    if (!connector || connector.kind !== "oauth") return reply.code(404).send({ error: "Unknown connector" });

    if (q.error || q.error_reason) {
      const reason = q.error_description || q.error_reason || q.error;
      return reply.redirect(backToAccounts({ error: `${connector.name} login was cancelled or failed: ${reason}` }));
    }
    const saved = q.state ? db.takeOAuthState(q.state) : undefined;
    if (!saved || saved.connector !== connector.id) {
      return reply.redirect(backToAccounts({ error: "That login link expired or was already used. Please try connecting again." }));
    }
    if (!q.code) return reply.redirect(backToAccounts({ error: `${connector.name} didn't return an authorization code.` }));

    try {
      const drafts = await connector.exchangeCode!(config, {
        code: q.code,
        redirectUri: redirectUri(config.publicBaseUrl, connector.id),
        codeVerifier: saved.code_verifier,
        query: q,
      });
      const ids = accounts.saveDrafts(connector.id, drafts);
      req.log.info(`connected ${ids.length} ${connector.name} account(s)`);
      return reply.redirect(backToAccounts({ connected: connector.name, count: String(ids.length) }));
    } catch (err) {
      req.log.error(err, `${connector.name} login failed`);
      const message = err instanceof Error ? err.message : String(err);
      return reply.redirect(backToAccounts({ error: `Connecting ${connector.name} failed: ${message}` }));
    }
  });
}
