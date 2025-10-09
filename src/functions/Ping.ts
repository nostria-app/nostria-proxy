import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

/**
 * Lightweight ping function for latency measurement.
 * Web clients can use this to determine their distance/latency from the deployed Azure Function.
 * 
 * Returns a minimal JSON response with a timestamp to allow clients to calculate round-trip time.
 */
export async function Ping(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    // Return immediately with minimal processing for accurate latency measurement
    return {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache, no-store, must-revalidate" // Prevent caching for accurate measurements
        },
        jsonBody: {
            pong: true,
            timestamp: Date.now()
        }
    };
}

app.http('Ping', {
    methods: ['GET', 'HEAD'],
    authLevel: 'anonymous',
    route: 'ping',
    handler: Ping
});
