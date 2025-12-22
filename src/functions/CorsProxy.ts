import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import axios from "axios";

// Allowed content types for proxying (primarily RSS/Atom feeds and related formats)
const ALLOWED_CONTENT_TYPES = [
    "application/rss+xml",
    "application/atom+xml",
    "application/xml",
    "text/xml",
    "application/json",
    "text/plain",
    "text/html"
];

const REQUEST_TIMEOUT = 15000; // 15 seconds
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB limit

/**
 * CORS Proxy function for fetching RSS feeds and other resources that block CORS.
 * 
 * Usage: GET /api/cors-proxy?url=<encoded-url>
 * 
 * This proxy:
 * - Fetches the requested URL from the server side (bypassing browser CORS restrictions)
 * - Adds appropriate CORS headers to allow browser access
 * - Validates content types to prevent abuse
 * - Implements timeouts and size limits for security
 */
export async function CorsProxy(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
        "Access-Control-Max-Age": "86400" // 24 hours
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
        return {
            status: 204,
            headers: corsHeaders
        };
    }

    // Get the URL to proxy
    const targetUrl = request.query.get("url");
    
    if (!targetUrl) {
        return {
            status: 400,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
            },
            jsonBody: {
                error: "Missing 'url' query parameter",
                usage: "GET /api/cors-proxy?url=<encoded-url>"
            }
        };
    }

    // Validate URL format
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(targetUrl);
    } catch {
        return {
            status: 400,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
            },
            jsonBody: {
                error: "Invalid URL format",
                url: targetUrl
            }
        };
    }

    // Only allow HTTP/HTTPS protocols
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return {
            status: 400,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
            },
            jsonBody: {
                error: "Only HTTP and HTTPS protocols are allowed",
                protocol: parsedUrl.protocol
            }
        };
    }

    try {
        context.log(`Proxying request to: ${targetUrl}`);

        const response = await axios.get(targetUrl, {
            timeout: REQUEST_TIMEOUT,
            maxContentLength: MAX_RESPONSE_SIZE,
            responseType: "arraybuffer",
            headers: {
                // Pass through common headers that might be needed
                "Accept": request.headers.get("accept") || "*/*",
                "Accept-Language": request.headers.get("accept-language") || "en-US,en;q=0.9",
                "User-Agent": "Nostria-Proxy/1.0 (RSS Feed Fetcher)"
            },
            // Follow redirects
            maxRedirects: 5,
            validateStatus: (status) => status < 500 // Accept any status below 500
        });

        // Get content type from response
        const contentType = response.headers["content-type"] || "application/octet-stream";
        const contentTypeBase = contentType.split(";")[0].trim().toLowerCase();

        // Check if content type is allowed
        const isAllowedType = ALLOWED_CONTENT_TYPES.some(allowed => 
            contentTypeBase === allowed || contentTypeBase.startsWith(allowed.split("/")[0] + "/")
        );

        if (!isAllowedType) {
            context.warn(`Blocked content type: ${contentType} for URL: ${targetUrl}`);
            return {
                status: 403,
                headers: {
                    ...corsHeaders,
                    "Content-Type": "application/json"
                },
                jsonBody: {
                    error: "Content type not allowed",
                    contentType: contentType,
                    allowedTypes: ALLOWED_CONTENT_TYPES
                }
            };
        }

        // Return the proxied response with CORS headers
        return {
            status: response.status,
            headers: {
                ...corsHeaders,
                "Content-Type": contentType,
                "Cache-Control": "public, max-age=300", // Cache for 5 minutes
                "X-Proxied-URL": targetUrl,
                "X-Original-Status": response.status.toString()
            },
            body: Buffer.from(response.data)
        };

    } catch (err) {
        if (axios.isAxiosError(err)) {
            const status = err.response?.status || 502;
            const message = err.message || "Unknown error";

            context.error(`Proxy error for ${targetUrl}: ${message}`);

            // Handle specific error cases
            if (err.code === "ECONNABORTED") {
                return {
                    status: 504,
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "application/json"
                    },
                    jsonBody: {
                        error: "Request timeout",
                        url: targetUrl,
                        timeout: REQUEST_TIMEOUT
                    }
                };
            }

            if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
                return {
                    status: 502,
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "application/json"
                    },
                    jsonBody: {
                        error: "Could not resolve host",
                        url: targetUrl
                    }
                };
            }

            return {
                status: status >= 400 && status < 600 ? status : 502,
                headers: {
                    ...corsHeaders,
                    "Content-Type": "application/json"
                },
                jsonBody: {
                    error: "Failed to fetch URL",
                    url: targetUrl,
                    message: message,
                    code: err.code
                }
            };
        }

        context.error(`Unexpected error proxying ${targetUrl}: ${err}`);
        return {
            status: 500,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
            },
            jsonBody: {
                error: "Internal server error",
                url: targetUrl
            }
        };
    }
}

app.http('CorsProxy', {
    methods: ['GET', 'HEAD', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'cors-proxy',
    handler: CorsProxy
});
