/**
 * OpenAI Responses API token sharing through Sign in with ChatGPT.
 *
 * This public-client flow uses no client secret and sends the resulting user
 * access token directly to api.openai.com.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";

const CLIENT_ID_ENV = "PI_OPENAI_OAUTH_CLIENT_ID";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 8080;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = "openid resource.invoke chatgpt.tokens.use.direct offline_access";

type CallbackServer = {
	server: Server;
	code: Promise<string>;
};

type TokenResponse = {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	id_token?: unknown;
};

function getClientId(): string {
	const clientId = getProviderEnvValue(CLIENT_ID_ENV)?.trim();
	if (!clientId) throw new Error(`Set ${CLIENT_ID_ENV} to use Sign in with ChatGPT`);
	return clientId;
}

function randomValue(): string {
	return randomBytes(32).toString("base64url");
}

function authorizationCodeFromCallback(url: URL, expectedState: string): string {
	const code = url.searchParams.get("code");
	if (!code) throw new Error("Missing authorization code");
	const state = url.searchParams.get("state");
	if (!state) throw new Error("Missing OAuth state");
	if (state !== expectedState) throw new Error("OAuth state mismatch");
	return code;
}

function authorizationCodeFromManualInput(input: string, expectedState: string): string {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("Paste the full callback URL from the browser");
	}
	const expected = new URL(REDIRECT_URI);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
		throw new Error(`The pasted callback URL must start with ${REDIRECT_URI}`);
	}
	const error = url.searchParams.get("error");
	if (error) throw new Error(`ChatGPT authorization failed: ${error}`);
	return authorizationCodeFromCallback(url, expectedState);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	response.end(body);
}

function startCallbackServer(expectedState: string): Promise<CallbackServer> {
	return new Promise((resolve, reject) => {
		let resolveCode!: (code: string) => void;
		let rejectCode!: (error: Error) => void;
		const code = new Promise<string>((resolveAuthorization, rejectAuthorization) => {
			resolveCode = resolveAuthorization;
			rejectCode = rejectAuthorization;
		});

		const server = createServer((request, response) => {
			try {
				const url = new URL(request.url || "", REDIRECT_URI);
				if (url.pathname !== CALLBACK_PATH) {
					sendHtml(response, 404, oauthErrorHtml("Callback route not found."));
					return;
				}

				const error = url.searchParams.get("error");
				if (error) {
					sendHtml(response, 400, oauthErrorHtml("ChatGPT was not connected.", `Error: ${error}`));
					rejectCode(new Error(`ChatGPT authorization failed: ${error}`));
					return;
				}

				let authorizationCode: string;
				try {
					authorizationCode = authorizationCodeFromCallback(url, expectedState);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Invalid callback";
					sendHtml(response, 400, oauthErrorHtml(message));
					return;
				}

				sendHtml(response, 200, oauthSuccessHtml("ChatGPT authentication completed. You can close this window."));
				resolveCode(authorizationCode);
			} catch {
				sendHtml(response, 500, oauthErrorHtml("Internal error while processing the callback."));
			}
		});

		server.once("error", reject);
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			server.removeListener("error", reject);
			server.on("error", rejectCode);
			resolve({ server, code });
		});
	});
}

async function requestToken(body: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
		signal,
	});
	if (!response.ok) {
		const responseBody = await response.text().catch(() => "");
		throw new Error(`OpenAI OAuth token request failed (${response.status}): ${responseBody || response.statusText}`);
	}
	const data: unknown = await response.json();
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("OpenAI OAuth token response must be an object");
	}
	return data as TokenResponse;
}

function credentialFromTokenResponse(token: TokenResponse, current?: OAuthCredential): OAuthCredential {
	if (
		typeof token.access_token !== "string" ||
		token.access_token.trim().length === 0 ||
		typeof token.expires_in !== "number" ||
		!Number.isFinite(token.expires_in) ||
		token.expires_in <= 0 ||
		(token.refresh_token !== undefined &&
			(typeof token.refresh_token !== "string" || token.refresh_token.trim().length === 0))
	) {
		throw new Error("OpenAI OAuth token response is missing required fields");
	}
	const refresh = token.refresh_token ?? current?.refresh;
	if (!refresh) throw new Error("OpenAI OAuth token response did not contain a refresh token");
	return {
		...current,
		type: "oauth",
		access: token.access_token,
		refresh,
		expires: Date.now() + token.expires_in * 1000,
	};
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	clientId: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const token = await requestToken(
		new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT_URI,
			resource: RESOURCE,
		}),
		signal,
	);
	if (typeof token.id_token !== "string" || token.id_token.trim().length === 0) {
		throw new Error("OpenAI OAuth token response did not contain an ID token");
	}
	return credentialFromTokenResponse(token);
}

async function refreshAccessToken(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const clientId = getClientId();
	const token = await requestToken(
		new URLSearchParams({
			grant_type: "refresh_token",
			client_id: clientId,
			refresh_token: credential.refresh,
			resource: RESOURCE,
		}),
		signal,
	);
	return credentialFromTokenResponse(token, credential);
}

async function loginOpenAIChatGPT(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const clientId = getClientId();
	const { verifier, challenge } = await generatePKCE();
	const state = randomValue();
	const nonce = randomValue();
	let callback: CallbackServer | undefined;
	try {
		callback = await startCallbackServer(state);
	} catch (error) {
		interaction.notify({
			type: "info",
			message: `Could not listen on ${REDIRECT_URI}; paste the final redirect URL to continue. ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	const authorizationUrl = new URL(AUTHORIZE_URL);
	authorizationUrl.search = new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		resource: RESOURCE,
		scope: SCOPE,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		nonce,
	}).toString();
	interaction.notify({
		type: "auth_url",
		url: authorizationUrl.toString(),
		instructions:
			"Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.",
	});

	const manualAbort = new AbortController();
	const manualCode = interaction
		.prompt({
			type: "manual_code",
			message: "Complete login in your browser, or paste the final redirect URL here:",
			placeholder: REDIRECT_URI,
			signal: AbortSignal.any([manualAbort.signal, interaction.signal]),
		})
		.then((input) => authorizationCodeFromManualInput(input, state));

	try {
		const code = await (callback ? Promise.race([callback.code, manualCode]) : manualCode);
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await exchangeAuthorizationCode(code, verifier, clientId, interaction.signal);
	} catch (error) {
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		throw error;
	} finally {
		manualAbort.abort();
		callback?.server.close();
	}
}

// TODO before release:
// - Validate the ID token signature against OpenAI's JWKS and verify its issuer,
//   audience, expiry, and nonce before using identity claims.
// - Add token-sharing traceability metadata after OpenAI confirms its contract.
// - Clear saved tokens and request reconnection after definitive revocation.
export const openaiChatGPTOAuth: OAuthAuth = {
	name: "OpenAI (ChatGPT subscription)",
	isSubscription: true,
	loginLabel: "Sign in with ChatGPT",
	login: loginOpenAIChatGPT,
	refresh: refreshAccessToken,
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
