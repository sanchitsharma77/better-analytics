import "./polyfills/compression";
import { Elysia } from "elysia";
import { clickhouse } from "@better-analytics/db/clickhouse";
import { randomUUID } from "node:crypto";
import { UAParser } from "ua-parser-js";
import { parse as parseDomain } from "tldts";
import { logger } from "./lib/logger";
import { extractIpFromRequest, getGeoData } from "./lib/ip-geo";
import { db, user } from "@better-analytics/db";
import { eq } from "drizzle-orm";
import { ErrorIngestBody, LogIngestBody, NotFoundIngestBody } from "./types";
import { Autumn } from "autumn-js";
import supabase from "./lib/soup-base";
import { LingoDotDevEngine } from "lingo.dev/sdk";

const lingoDotDev = new LingoDotDevEngine({
	apiKey: process.env.LINGODOTDEV_API_KEY || "",
});

// Translation cache - stores results for 5 minutes
const translationCache = new Map<string, { result: any; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

function getCacheKey(
	content: string | object,
	sourceLocale: string,
	targetLocale: string,
): string {
	const contentStr =
		typeof content === "string" ? content : JSON.stringify(content);
	return `${contentStr}-${sourceLocale}-${targetLocale}`;
}

function getCachedResult(cacheKey: string): any | null {
	const cached = translationCache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
		return cached.result;
	}
	if (cached) {
		translationCache.delete(cacheKey); // Clean up expired cache
	}
	return null;
}

function setCachedResult(cacheKey: string, result: any): void {
	translationCache.set(cacheKey, { result, timestamp: Date.now() });
}

async function checkQuota(feature_id: string, customer_id: string) {
	try {
		const { data } = await Autumn.check({
			feature_id,
			customer_id,
			send_event: true,
		});

		return data?.allowed ?? false;
	} catch (error) {
		logger.error(`Failed to check quota for ${feature_id}:`, error);
		return true;
	}
}

async function sendRealTimeEvent(userId: string, event: string, payload: any) {
	try {
		const channel = supabase.channel(`user:${userId}`);
		await channel.send({
			type: "broadcast",
			event,
			payload,
		});
		logger.info(`Sent real-time ${event} event to user ${userId}`);
	} catch (error) {
		logger.error(`Failed to send real-time event to user ${userId}:`, error);
	}
}

function replaceUndefinedWithNull(obj: any): any {
	if (Array.isArray(obj)) {
		return obj.map(replaceUndefinedWithNull);
	}
	if (obj && typeof obj === "object") {
		return Object.fromEntries(
			Object.entries(obj).map(([k, v]) => [
				k,
				v === undefined ? null : replaceUndefinedWithNull(v),
			]),
		);
	}
	return obj;
}

function toCHDateTime64(
	date: Date | string | number | null | undefined,
): string | null {
	if (!date) return null;
	const d = new Date(date);
	if (Number.isNaN(d.getTime())) return null;
	const pad = (n: number, z = 2) => String(n).padStart(z, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const app = new Elysia()
	.onBeforeHandle(async ({ request, set }) => {
		const origin = request.headers.get("origin");
		if (origin) {
			set.headers ??= {};
			set.headers["Access-Control-Allow-Origin"] = origin;
			set.headers["Access-Control-Allow-Methods"] =
				"POST, GET, OPTIONS, PUT, DELETE, HEAD, PATCH";
			set.headers["Access-Control-Allow-Headers"] =
				"Content-Type, Authorization, X-Requested-With, databuddy-client-id, databuddy-sdk-name, databuddy-sdk-version";
			set.headers["Access-Control-Allow-Credentials"] = "true";
		}
	})
	.options("*", () => new Response(null, { status: 204 }))
	.derive(async ({ request, set, body }) => {
		const pathname = new URL(request.url).pathname;

		// Skip auth for public endpoints
		if (
			pathname === "/" ||
			pathname === "/localization" ||
			pathname === "/localization/object" ||
			pathname === "/api/localization" ||
			pathname === "/api/localization/object" ||
			request.method === "OPTIONS"
		) {
			return { userId: null };
		}

		const authHeader = request.headers.get("Authorization");
		const potentialBody = body as { accessToken?: string };

		const accessToken = authHeader?.startsWith("Bearer ")
			? authHeader.substring(7)
			: potentialBody?.accessToken;

		if (!accessToken) {
			// For now, allow requests without tokens but set userId to null
			// set.status = 401;
			// throw new Error("Unauthorized. Access token is missing.");
			return { userId: null };
		}

		try {
			const userExists = await db.query.user.findFirst({
				columns: { id: true },
				where: eq(user.accessToken, accessToken),
			});

			// if (!userExists) {
			//     set.status = 401;
			//     throw new Error("Unauthorized. Invalid access token.");
			// }

			return { userId: userExists?.id || null };
		} catch (error) {
			console.error("Auth error:", error);
			return { userId: null };
		}
	})
	.get("/", () => "Better Analytics API")
	.post(
		"/ingest",
		async ({ body, request, set, userId }) => {
			logger.info("Received request on /ingest endpoint.");

			const isAllowed = await checkQuota("error", body.client_id);
			if (!isAllowed) {
				set.status = 429;
				return {
					status: "error",
					message: "Quota exceeded for error ingestion.",
				};
			}

			const userAgent = request.headers.get("user-agent") || "";
			const uaResult = UAParser(userAgent);
			const ip = extractIpFromRequest(request);
			const geo = await getGeoData(ip);
			const domainInfo = body.url ? parseDomain(body.url) : null;
			const now = new Date();

			const errorData = {
				id: randomUUID(),
				...body,
				tags: body.tags ?? [],
				occurrence_count: body.occurrence_count ?? 1,
				source: body.source || domainInfo?.domain,
				user_agent: userAgent,
				browser_name: body.browser_name ?? uaResult.browser.name,
				browser_version: body.browser_version ?? uaResult.browser.version,
				os_name: body.os_name ?? uaResult.os.name,
				os_version: body.os_version ?? uaResult.os.version,
				device_type: body.device_type ?? uaResult.device.type ?? "desktop",
				ip_address: ip,
				country: geo.country,
				region: geo.region,
				city: geo.city,
				org: geo.org,
				postal: geo.postal,
				loc: geo.loc,
				first_occurrence:
					toCHDateTime64(body.first_occurrence) || toCHDateTime64(now),
				last_occurrence:
					toCHDateTime64(body.last_occurrence) || toCHDateTime64(now),
				resolved_at: toCHDateTime64(body.resolved_at),
				created_at: toCHDateTime64(now),
				updated_at: toCHDateTime64(now),
			};

			const sanitizedErrorData = replaceUndefinedWithNull(errorData);
			try {
				await clickhouse.insert({
					table: "errors",
					values: [sanitizedErrorData],
					format: "JSONEachRow",
				});

				if (userId) {
					await sendRealTimeEvent(userId, "error_ingested", {
						id: sanitizedErrorData.id,
						message: sanitizedErrorData.message,
						severity: sanitizedErrorData.severity,
						error_type: sanitizedErrorData.error_type,
						source: sanitizedErrorData.source,
						client_id: sanitizedErrorData.client_id,
						created_at: sanitizedErrorData.created_at,
						url: sanitizedErrorData.url,
						browser_name: sanitizedErrorData.browser_name,
						os_name: sanitizedErrorData.os_name,
						device_type: sanitizedErrorData.device_type,
						country: sanitizedErrorData.country,
						city: sanitizedErrorData.city,
					});
				}

				return { status: "success", id: sanitizedErrorData.id };
			} catch (error) {
				logger.error({ message: "Failed to ingest error:", error });
				return { status: "error", message: "Failed to process error" };
			}
		},
		{ body: ErrorIngestBody },
	)
	.post(
		"/log",
		async ({ body, set, userId }) => {
			logger.info("Received request on /log endpoint.");

			const isAllowed = await checkQuota("log", body.client_id);
			if (!isAllowed) {
				set.status = 429;
				return {
					status: "error",
					message: "Quota exceeded for log ingestion.",
				};
			}

			const logData = {
				id: randomUUID(),
				...body,
				created_at: toCHDateTime64(new Date()),
			};

			try {
				await clickhouse.insert({
					table: "logs",
					values: [logData],
					format: "JSONEachRow",
				});

				if (userId) {
					await sendRealTimeEvent(userId, "log_ingested", {
						id: logData.id,
						message: logData.message,
						level: logData.level,
						source: logData.source,
						client_id: logData.client_id,
						created_at: logData.created_at,
						context: logData.context,
						environment: logData.environment,
						session_id: logData.session_id,
						user_id: logData.user_id,
					});
				}

				await sendRealTimeEvent(body.client_id, "new-log", logData);

				return { status: "success", id: logData.id };
			} catch (error) {
				logger.error("Failed to ingest log:", error);
				return { status: "error", message: "Failed to process log" };
			}
		},
		{ body: LogIngestBody },
	)
	.post(
		"/track-404",
		async ({ body, request, set }) => {
			logger.info("Received request on /track-404 endpoint.");

			const isAllowed = await checkQuota("404_page_tracking", body.client_id);
			if (!isAllowed) {
				set.status = 429;
				return {
					status: "error",
					message: "Quota exceeded for 404 tracking.",
				};
			}

			const userAgent = request.headers.get("user-agent") || "";
			const ip = extractIpFromRequest(request);
			const geo = await getGeoData(ip);

			const data = {
				id: randomUUID(),
				...body,
				user_agent: userAgent,
				ip_address: ip,
				country: geo.country,
				region: geo.region,
				city: geo.city,
				created_at: toCHDateTime64(new Date()),
			};

			const cleanedData = replaceUndefinedWithNull(data);

			await clickhouse.insert({
				table: 'not_found_pages',
				values: [cleanedData],
				format: 'JSONEachRow'
			});

			await sendRealTimeEvent(body.client_id, "new-404", cleanedData);

			return {
				status: "success",
				id: data.id
			};
		},
		{
			body: NotFoundIngestBody
		},
	)
	.post("/localization", async ({ body, set }) => {
		logger.info("Received request on /api/localization endpoint.");

		try {
			const { key, language = "en" } = body as {
				key: string;
				language?: string;
			};

			if (!key) {
				set.status = 400;
				return { error: "Key is required" };
			}

			const cacheKey = getCacheKey(key, "en", language || "en");
			const cachedResult = getCachedResult(cacheKey);

			if (cachedResult) {
				return { result: cachedResult };
			}

			const result = await lingoDotDev.localizeText(key, {
				sourceLocale: "en",
				targetLocale: language || "en",
				fast: true,
			});

			setCachedResult(cacheKey, result);

			return { result };
		} catch (error) {
			logger.error(error);
			set.status = 500;
			return { error: "Translation failed" };
		}
	})
	.post("/localization/object", async ({ body, set }) => {
		logger.info("Received request on /api/localization/object endpoint.");

		try {
			const {
				content,
				sourceLocale = "en",
				targetLocale = "en",
			} = body as {
				content: Record<string, string>;
				sourceLocale?: string;
				targetLocale?: string;
			};

			if (!content || typeof content !== "object") {
				set.status = 400;
				return { error: "Content object is required" };
			}

			const cacheKey = getCacheKey(content, sourceLocale, targetLocale);
			const cachedResult = getCachedResult(cacheKey);

			if (cachedResult) {
				return { result: cachedResult };
			}

			const result = await lingoDotDev.localizeObject(content, {
				sourceLocale,
				targetLocale: "ar",
				fast: true,
			});

			setCachedResult(cacheKey, result);

			return { result };
		} catch (error) {
			logger.error(error);
			set.status = 500;
			return { error: "Object translation failed" };
		}
	})
	.onError(({ error, set }) => {
		const errorMessage = (error as any)?.message || "An unknown error occurred";
		logger.error(error);

		if (errorMessage.includes("Unauthorized")) {
			set.status = 401;
			return {
				status: "error",
				message: errorMessage,
			};
		}

		set.status = 500;
		return {
			status: "error",
			message: "An internal error occurred.",
		};
	})
	.listen(process.env.PORT || 4000);

logger.info(
	`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);

export type App = typeof app;
